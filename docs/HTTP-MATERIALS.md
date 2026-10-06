# HTTP 자료 수집

## 목록

`learningx-client.ts`는 Canvas `sessionless_launch` URL의 LTI 폼을 POST해
`xn_api_token`을 얻고, LearningX 읽기 API에 Bearer로 전달한다.

| 소스 | 엔드포인트 |
| --- | --- |
| 강의자료실 | `/learningx/api/v1/courses/{course_id}/resources_db?user_login=...` |
| 주차학습 | `/learningx/api/v1/courses/{course_id}/modules?include_detail=true` |
| 게시판 목록 | `/learningx/api/v1/learningx_board/courses/{course_id}/boards/{board_id}/posts?page=...&per_page=100` |
| 게시판 첨부 | 위 posts 경로의 `/{post_id}` |

모듈의 `lecture_period_status=not_open`과 콘텐츠 ID `not_open`은 제외한다.
목록 응답의 예상 envelope가 바뀌면 소스 오류로 보고한다.

## ExternalTool

`http-materials.ts`는 계정 HTTP 쿠키로 Canvas 과목 래퍼를 읽고,
`lti_message_type`을 가진 POST 폼을 같은 origin의 `/learningx/lti/`에 제출한다.
iframe·정적인 redirect 주소는 HTTP 세션과 같은 HTTPS 목적지 경계(eclass3·canvas·mportal2·ocs)를 사용한다.
OCS 중간 페이지도 읽고, 한 후보가 빈 페이지이거나 실패하면 남은 후보를 탐색한다.
동일 메서드·목적지의 중복 요청은 건너뛰고 런치당 최대 40페이지를 읽는다.
POST 이후 같은 주소의 GET이 필요한 흐름은 별도로 탐색한다. 서명된 LTI POST는 같은 origin의
`/learningx/lti/`로 제한한다. 페이지 JavaScript는 실행하지 않는다.
성공한 후보가 없을 때는 재시도 가능한 실패를 우선 선택하고, 같은 재시도 범주에서는
프로토콜·타입 진단을 HTTP 상태·일반 오류보다 우선한다. 모든 후보가 막다른 페이지라면
`EXTERNAL_TOOL_NO_ARTIFACT`를 반환한다.

게시판은 목록의 `pagination.last_page`를 따라 최대 20페이지·게시글 상세 50건·60초의 범위에서 읽고,
비밀글·첨부 없는 글을 건너뛴 뒤 같은 origin의 Canvas 파일 첨부를 선택한다.
특정 글의 URL이면 그 글만 조회한다. 주차학습 래퍼는 요청한 module item ID로
modules 응답을 찾아 OCS locator 또는 영상 여부를 반환한다.
읽기 경로는 진도·출석 기록 API를 호출하지 않는다.

`ExternalTool` 타입 또는 입력의 `requires_launch`가 런치 해석을 선택한다.
자료 목록에는 타입·locator·획득 정책이 담긴다.

## OCS 문서

`https://ocs.cau.ac.kr/em/{content_id}`의 문서는 아래 XML에서 원본 주소를 얻는다.

`/viewer/ssplayer/uniplayer_support/content.php?content_id={content_id}`

XML의 ID가 요청과 일치하고 `content_type=sharedocs`일 때만 `content_download_uri`를 쓴다.
목적지는 OCS `/index.php`, `xn_media_content2013/dispXn_media_content2013DownloadWebFile`,
동일 content ID로 제한한다.

UniPlayer 메타데이터에 `content_id` 구조가 없으면 `/em/{id}`에서 구형 File viewer 여부를 확인한다.
서버 오류 문구에 의존하지 않고, viewer의
`playerType=File`, `content_type=17`, 같은 content ID를 확인한 뒤, 다운로드 버튼의
정적 `dispXn_media_content2013DownloadContent` 주소를 사용한다. 이 경우도 HTTPS OCS
`/index.php`와 같은 module·content ID를 검증한다. 타입 없는 OCS 자료도 명시적인
`resolve_external` 요청에서 메타데이터를 확인해 문서·영상 여부를 결정한다.

다운로드 시 메타데이터·viewer를 재조회해 식별자와 원본 목적지를 다시 검증한다.
런치 해석과 다운로드는 저장된 인증 HTTP 세션을 사용하며,
쿠키는 도메인·경로가 일치할 때만 전송한다. 파일에는 Canvas Bearer를 보내지 않는다.
원본을 임시 파일로 스트리밍한 뒤 완료 시 rename하고, 중단된 파일은 삭제한다.
HTML·영상 MIME 응답은 문서로 저장하지 않는다. 이름·확장자는 공통 filename 규칙을 따른다.

획득 전략은 `canvas_file`, `direct_url`, `ocs_http`, `external_tool_launch`,
`missing_locator`, `unsupported_streaming_media`, `already_cached`다.

## 실행·검증

```bash
pnpm exec tsx scripts/probe-http-materials.ts <course_id> [course_id ...]
pnpm exec tsx scripts/probe-http-history.ts > /tmp/eclass-http-history.jsonl
pnpm exec tsx scripts/discover.ts page https://eclass3.cau.ac.kr/courses/<course_id>/modules
pnpm test
pnpm run build
```

probe는 목록 개수, 표본 PDF 서명·확장자, ExternalTool 결과와 첨부 파일 서명을 출력한다.
브라우저 호출은 즉시 실패시키며 표본 다운로드는 임시 디렉터리에 저장하고 종료 시 삭제한다.
학교 원본 응답이나 토큰·쿠키는 출력·커밋하지 않는다.

Playwright는 과제 제출 UI 보조와 제출 폼 dry-run 탐사에만 동적으로 로드한다.
`playwright`는 optional dependency이고, Chromium은 필요한 환경에서
`pnpm run install:browser`로 준비한다. 기본 설치·doctor·페이지 탐사는 HTTP로 실행한다.

2026-10-06 검증: 실제 6개 강의의 자료 목록을 조회하고 OCS PDF 원본과
게시판 PPTX의 파일 서명을 확인했다. 서버가 아직 공개하지 않은 자료는 `not_open`으로 제외했다.
Playwright 패키지가 없는 상태에서도 새 HTTP SSO·포털 세션, 자료 다운로드와 doctor가
성공했고, 전체 테스트 462개와 TypeScript 빌드가 통과했다.

기존 입력의 `is_playwright_required` 및 오탈자 별칭은 입력 호환성으로만 수용한다.
도구 스키마와 사용 안내는 `requires_launch` 및 `ExternalTool` 타입을 사용한다.

2026-10-06 재검증: OCS 다운로드에 인증 HTTP 세션을 전달하도록 수정한 뒤,
`pnpm exec tsx scripts/probe-http-materials.ts 147788 147850`이 종료 코드 0으로 완료됐다.
브라우저 호출은 즉시 실패하도록 설정하고, 아래 표본은 임시 저장 후 삭제했다.

| 경로 | 크기(bytes) | 확인 |
| --- | ---: | --- |
| OCS PDF 및 ExternalTool → OCS PDF | 1,533,286 | `%PDF-`, `.pdf` 확장자 |
| ExternalTool → OCS PDF | 2,210,211 | `%PDF-` |
| 게시판 ExternalTool → PPTX | 837,102 | `PK` |

쿠키 회귀 테스트는 OCS 메타데이터와 원본 파일 모두에 OCS 세션 쿠키가 전달되고,
eclass 전용 쿠키 및 Canvas Authorization이 전송되지 않음을 확인한다.
서버에서 발견한 잠금은 다운로드 결과의 `not_open`/`wait_until_open`으로 반환한다.
허용되지 않은 iframe·정적 redirect 후보는 건너뛰고, 초과 크기 페이지는 reader를 취소한다.
전체 테스트 472개와 TypeScript 빌드가 통과했다.

## 수강 이력 탐사

`probe-http-history.ts`는 student enrollment의 available/completed 강의를 페이지 끝까지 조회한다.
여섯 자료 소스의 목록을 병합하고, 공개된 문서와 미분류 OCS/ExternalTool locator를 검사한다.
영상·상호작용 항목은 제외하고, 직접 파일 URL은 GET 응답 헤더를 받은 뒤 본문을 취소한다.
서명된 저장소 URL은 HEAD를 거부할 수 있으므로 HEAD 오류를 다운로드 실패로 판정하지 않는다.
출력에는 강의·자료 식별자, 학기, 결과 개수, 오류 종류만 담긴다. 본문·쿠키·토큰은 저장하지 않는다.
학교가 목록/API 접근을 거부한 소스와 HTTP 해석 실패는 별도로 기록한다.

2026-10-06 발견한 구형 OCS File(type 17) 원본을 HTTP로 받아 ZIP 서명과 481,360바이트를
확인하고 임시 파일을 삭제했다. 이 형식은 UniPlayer XML 경로와 별도로 지원한다.

이력 전체 재검사(2026-10-06)는 종료 코드 0으로 완료됐다.

| 항목 | 결과 |
| --- | ---: |
| 조회 가능한 student enrollment 강의 | 44 |
| 병합된 자료 항목 | 929 |
| 실제 검사한 중복 없는 locator(과목별) | 517 |
| 문서 경로 해석 또는 파일 응답 헤더 확인 | 255 |
| 영상 분류(다운로드 제외) | 75 |
| 잠금·기간 미공개 분류 | 252 |
| 상호작용 항목 제외 | 157 |
| 남은 실패 후보 | 35 |

분류 개수는 목록 항목 기준이고 locator 검사는 URL 중복을 제거한다. 원본 전체를 다운로드한
전수 검증은 아니다. 최초 탐사에서 메타데이터 해석에 실패했던 구형 File locator 11개가
재검사에서 정상 해석됐다. 서명 URL의 HEAD 403은 GET 정상 응답으로 확인했다.

남은 35개를 `--retry-failures /tmp/eclass-http-history.jsonl`로 별도 재검사해 다음을 확인했다.
OCS 25개는 서버의 `API Request fail` HTML을 반환해 `OCS_UPSTREAM_UNAVAILABLE`로 구분됐다.
ExternalUrl 10개는 일반 HTML 응답 7개, HTTP 400·404·401 각 1개였다. 이들은 문서 다운로드
성공으로 계산하지 않았다. 목록 소스의 401은 총 53건(Files 43건, 나머지 다섯 소스 각 2건)이며,
강의 두 개는 여섯 소스 모두 접근이 거부됐다. 이 범위의 데이터 존재·형식은 검증하지 못했다.

이 탐사는 예외 형식 발견과 현재 HTTP 경로 검증이다. 기존 브라우저 경로와의 전수 차분 검증이나
모든 학사 이력에 대한 접근을 증명하지 않는다. 전체 테스트 483개와 TypeScript 빌드가 통과했다.
