# HTTP 전환 후 기능 점검 — 2026-10-06 (KST)

대상: `7ba2fe2`, 현재 checkout에서 새로 빌드한 `dist/index.js`.
기존 연결 서버 대신 MCP SDK Client + StdioClientTransport로 새 서버 프로세스를 실행했다.
파일/시험 DB는 임시 디렉터리의 별도 DB를 사용했다. 실제 과제 제출과 영상 다운로드는 하지 않았다.

## 자동 검증

- `pnpm test`: 432/432 통과, 실패/skip 0.
- `pnpm run build`: 통과.
- `git diff --check`: 통과.
- MCP initialize 및 tools/list: 성공, 도구 24개 노출.

## 실제 기능 검증

| 기능 | 관찰 결과 |
| --- | --- |
| HTTP SSO 새 로그인 | 빈 HttpSession에서 로그인 후 e-Class self/profile 및 mportal 현재 학기 요청 성공 |
| 쿠키·API 토큰 강제 갱신 | 임시 스크립트로 새 HTTP 로그인·V2 토큰 발급·Keychain 저장·인증 확인 성공. 이전 토큰은 수동 HTTP 폴백으로 폐기 확인 |
| doctor | 자격증명 저장소, 캐시 API 토큰, 강의 API, courseresource 점검 통과 |
| 강의 범위/캐시 | current 6개, all 42개, training 9개, current 캐시 6개 유지 |
| 과제/공지 | 이번 학기 6개 강의 모두 조회 성공 |
| 자료 | 6개 강의 각각 5종 소스 모두 성공, 합계 75개 항목. ExternalTool 추가 해석 포함 |
| 성적 | 대표 강의 조회 성공, errors 없음 |
| 강의 메타데이터 | 대표 강의 1개 강제 동기화 성공 |
| 문서 다운로드 | 격리된 다운로드 경로에 실제 저장 성공. 기존 HTTP probe로 PDF 서명과 확장자 확인 |
| 문서 배치 | 이미 받은 파일 재호출 시 캐시 skip 경로 성공 |
| 로컬 파일 도구 | 목록/검색/현황/파일 전달/기록 삭제 성공. 삭제는 테스트 DB 레코드에만 수행 |
| 백업 | 대표 강의 JSON(29,334 bytes), Markdown(2,871 bytes) 파일 생성, partial_failures 없음 |
| 강의계획서 | 알고리즘 검색 후보 6개. 상세 basic/instructor/objectives/textbooks/assessment/schedule/raw_text 반환 성공 |
| 과제 상세/dry-run | 실제 과제 상세 성공. 허용되지 않는 txt 제출은 확장자 오류. c 파일 + dry_run + confirm_resubmit으로 검증 성공 |
| 없는 과제 | ASSIGNMENT_NOT_FOUND 정상 반환 |
| 시험 소스 | refresh로 후보 39개 발견 |
| 과거 시험 | 2026-1 기말 공지 3개, 교양 664행 + 경영경제 98행 = 762행 조회 성공. PDF 1개 부분 실패 |
| 이번 학기 시험 | 2026-2 중간 동기화에서 문서 없음. 조회는 NO_SCHEDULES 반환. 공지 미게시 여부는 별도 확인하지 않음 |

HTTP 자료 probe는 `ensurePlaywrightReady`를 예외로 바꿔 브라우저 호출이 발생하면 실패하도록 했다.
잠긴 항목은 not_open, 영상은 video/movie로 분류되며 영상 바이트는 받지 않았다.
단, 일반 MCP 프로세스에서 Playwright 패키지 자체를 제거한 환경 테스트는 하지 않았다.

## 발견한 문제 — 최초 점검 결과

1. **오류 응답과 outputSchema 충돌** — 2026-10-07 수정, 아래 회귀 검증 참고
   - `eclass_get_materials { course_id: -1 }`: 원래 입력 오류 대신 MCP -32602, required property `ok` 오류.
   - `eclass_file_handoff { file_id: "nonexistent-functional-test" }`: 원래 not_found 대신 MCP -32602, required properties `file_id`, `delivered` 오류.
   - 서버가 오류 JSON도 structuredContent로 정규화하고, SDK 클라이언트가 반환된 structuredContent를 성공 출력 스키마로 검증하는 경로에서 재현했다.
   - 관련 코드: `src/server.ts` catch/handoff 반환, `src/tools/registry.ts` normalizeToolResult 및 도구별 outputSchema.

2. **시험 PDF 일부 미지원**
   - `2026-1학기 기말시험 시간표, 서약서 작성 안내`의 첨부 PDF에서 행 0개.
   - partial_failures: `EXAM_PARSER_UNSUPPORTED: 시험 시간표 행을 식별하지 못했습니다.`
   - 나머지 2개 PDF의 시간표 조회는 성공했다. PDF 내용을 직접 확인하거나 파서 수정은 하지 않았다.

## 인증 강제 갱신 관련 확인

현재 외부 공개 MCP 도구/CLI에는 강제 재인증 옵션이 없다.
쿠키는 세션 인증 실패/만료 시 HTTP 로그인으로, API 토큰은 캐시 만료/인증 401 시 기존 토큰 교체 절차로 갱신한다.
추가 검증에서 임시 스크립트가 기존 계정 잠금/토큰 교체 로직을 호출해 새 쿠키와 V2 API 토큰을 발급·저장했다. 새 쿠키의 authenticated 검사와 새 토큰의 users/self 요청이 성공했다.

기존 토큰 ID 265274 → 새 토큰 ID 271411. 새 토큰 만료는 2027-01-04T12:22:20Z. 자동 이전 토큰 폐기는 성공하지 않아 /profile/tokens/265274의 HTTP 세션+폼 CSRF로 수동 폐기했다(200, 재확인 404). 새 토큰 자체의 인증은 정상이다. 다른 폐기 대기 항목 1개는 남아 있다. 임시 스크립트는 삭제했다.

따라서 강제 발급·저장·인증·수동 이전 토큰 폐기는 검증 완료지만, 자동 폐기 경로는 결함이 확인됐고 실제 401 유발 후 자동 갱신은 검증하지 않았다.
수동 기능을 추가한다면 cookies/token/both를 구분하고 기존 계정 잠금, 새 토큰 저장 및 이전 토큰 폐기 절차를 재사용해야 한다.

## 검증 범위와 생성 파일

- 실제 제출 및 Playwright 제출 UI는 자동 테스트만 통과한 상태이며 실서비스 제출 테스트는 하지 않았다.
- 영상 다운로드는 자동 테스트/HTTP 메타데이터 분류만 확인했다.
- 토큰 캐시 사용, 새 쿠키 로그인, 강제 토큰 발급/저장/인증을 검증했다. 이전 토큰 자동 폐기는 실패해 수동 HTTP 폴백으로 완료했다. 실제 인증 401을 유발하는 테스트는 하지 않았다.
- 시험 공지 점검은 기본 시험 다운로드 경로 `~/Downloads/eclass-exams/2026-1/final/`을 사용했다. PDF는 남겨 두었다.
- 테스트용 문서/DB/스냅샷과 임시 실행 스크립트는 점검 종료 후 제거했다. 서비스 소스는 수정하지 않았다.


## 추가 조사 결과

### MCP 오류 계약

실제 SDK Client + InMemoryTransport + 현재 빌드한 서버를 사용해 네트워크 없이 재현했다. 인증 단계가 먼저 실행되는 도구에는 정상적으로 반환하는 client stub을 넣어 입력 검증까지 도달하게 했다.

- 원인은 공통 catch가 `ZodError.message`(JSON 배열)를 텍스트로 반환하고, `normalizeToolResult`가 이를 JSON 파싱해 `{result: [검증 오류]}`로 만드는 것이다.
- SDK는 `isError=true`라도 structuredContent가 있으면 해당 도구의 outputSchema로 검증한다.
- 재현 도구: get_materials(-1 course_id), get_courses(invalid scope), list_exam_sources(invalid refresh), search_syllabus(empty query), get_download_status(-1 course_id), remove_download(-1 course_id), file_handoff(missing file).
- get_assignments(days_ahead=0)는 SDK 예외 대신 `isError=true, structuredContent.result=[Zod 검증 오류]`가 반환된다. 배열 스키마가 느슨해 통과할 뿐, 과제 목록과 같은 모양으로 오류를 전달하는 문제가 있다.
- 없는 파일의 오류는 `{code:not_found,message:...}`인데 성공 스키마의 필수 file_id/delivered와 맞지 않는다. 이는 입력 검증 외에 실제 도구 실패도 영향을 받는다는 증거다.
- 수정 방향: 입력 검증/도구 실패를 공통 오류 객체로 만들고 성공·오류 두 형태를 outputSchema에 명시한다. 또는 오류일 때 structuredContent를 생략하는 최소 수정도 가능하지만 구조화된 오류 전달은 포기하게 된다.
- 관련 위치: src/server.ts 입력 검증 전 getClient 호출과 공통 catch, src/tools/registry.ts normalizeToolResult 및 outputSchema.

### PDF 열 위치 문제

원본: `/Users/jskm/Downloads/eclass-exams/2026-1/final/2026-1학기 기말시험 시험유형 및 시간표_공지_최종_v2.pdf`.
6페이지 A3 가로 문서를 pdftotext TSV/레이아웃 텍스트로 추출하고 1페이지를 렌더링해 비교했다.

- 스캔/OCR 문제가 아니다. 텍스트와 표가 존재한다.
- business_economics 레이아웃 감지는 성공한다. 그 뒤 고정 열 경계가 실제 표와 다르다.
- 예: 첫 행에서 학수번호 x=97.20, 분반 x=131.90, 강의명 x=156.86, 강의시간 x=557.45, 교수명 x=639.19, 시험유형 x=707.83. 기존 hasCredits 배열은 강의명 종료 x=238, 교수명 시작 x=676, 시험유형 시작 x=770 등으로 고정되어 있다.
- 서비스 소스 대신 임시 파서 복사본에서 열 경계만 조정했을 때 0행 → 416행으로 바뀌었다. 첫 몇 행의 강의명·날짜·시각·고사실이 실제 표와 맞는 것을 확인했다. 전체 필드 정확성까지 검증한 정식 수정은 아니다.
- TSV의 연도 앵커는 428개이며 시험유형 셀이 비어 있는 12개 행이 있다. 임시 파서는 유형이 있는 416개 행만 반환한다. 데이터 덤프는 이 12개도 보존해야 한다.
- 현재 파서는 PDF 전체의 헤더 유무/좌표로 한 레이아웃을 고르고 고정 x좌표를 사용한다. 문서마다 인쇄 배율·열 순서·줄바꿈이 바뀌는 것에 취약하다. 숫자 행 범위(예: 3~15행)를 고정하는 구현은 아니다.

### 토큰 자동 폐기 경로

활성 토큰 ID 271411로 인증 성공을 확인한 상태에서 이미 폐기한 이전 ID 265274에 한정해 경로 차이를 확인했다. 토큰 목록 API는 다시 조회하지 않았다.

- bearer 인증 + DELETE /api/v1/users/self/tokens/265274: HTTP 422.
- HTTP 쿠키 + 폼 authenticity_token을 CSRF 헤더로 사용한 같은 API 경로: HTTP 404(이미 폐기).
- HTTP 쿠키 + 폼 CSRF + DELETE /profile/tokens/265274: 폐기 때 200, 이후 재확인 404.
- 실제 settings HTML에는 csrf-token meta가 없고 /profile/tokens 생성 폼의 authenticity_token이 있다.
- revokeCanvasToken은 bearer API만 사용한다. revokeCanvasTokenFromSession은 csrf-token meta만 읽으며 폼 CSRF fallback이 없다. 둘 다 실제 환경의 정상 폐기 경로를 충분히 처리하지 못한다.
- 422의 구체적 서버 이유는 확인하지 못했다. 새 토큰이 무효라는 증거가 아니라, 토큰 삭제 경로가 다른 인증/CSRF 조건을 요구한다는 관찰이다.
- 자동 테스트는 DELETE가 성공하는 mock 및 meta CSRF가 있는 HTML만 사용해 이 차이를 놓쳤다.

## 시험 기능 역할을 느슨하게 하는 방향

사용자의 방향에 맞춰 고정 PDF 양식별 정규화를 필수 단계로 두지 않는 설계를 제안한다. 이번 조사에서는 서비스 소스를 변경하지 않았다.

1. **자료 확보를 기본 성공 기준으로 둔다.** 공지 URL/제목/게시일, PDF URL/로컬 경로, 해시, 가져온 시각을 제공한다. 이 단계 성공과 텍스트 추출·해석 성공을 구분한다.
2. **원문을 반환한다.** 전체 레이아웃 텍스트와 페이지 경계를 보존한다. 긴 자료는 document_id와 페이지 범위/검색으로 필요한 부분만 읽게 한다. 스캔 PDF는 원본 전달과 text_unavailable 상태를 제공한다.
3. **해석은 선택 기능으로 둔다.** 기존 정규화 결과나 휴리스틱 후보는 parsed/partial/unparsed 상태와 근거 페이지를 붙여 제공한다. 파싱 실패를 문서 확보 실패로 취급하지 않는다.
4. **휴리스틱은 값의 위치를 관찰해 추론한다.** 헤더 이름, 날짜/시간 패턴, 반복 행 구조, 같은 페이지의 좌표 관계를 사용하되 특정 열 x좌표나 특정 행 범위를 필수 조건으로 두지 않는다. 빈 값·미인식 행도 원문에 남긴다.
5. **호출하는 AI가 해석할 수 있게 한다.** 시간표가 DB에 없다는 이유만으로 NO_SCHEDULES만 주지 말고 해당 문서와 원문 접근 방법도 반환한다. 여러 공지의 변경 시각/해시/출처를 유지해 최신 여부 판단에 필요한 근거를 준다.

현재 동기화 도구는 파싱에 실패해도 PDF 메타데이터/로컬 경로를 반환하지만, 원문 텍스트를 반환하지 않는다. 조회 도구는 정규화된 DB 행만 보므로 원문이 있는데도 NO_SCHEDULES가 된다. 이 두 경로를 이어 주는 것이 열 좌표를 계속 추가하는 것보다 먼저 할 일이다.

### 수정 우선순위 제안

1. MCP 오류 응답 계약을 일관되게 만들어 원래 오류를 가리지 않게 한다.
2. 시험 자료의 원문/문서 조회 경로를 제공하고, 파싱을 선택적인 해석으로 내린다.
3. 토큰 폐기에 HTTP 쿠키 및 폼 CSRF 경로를 반영한다. 강제 재발급 기능을 넓히기 전에 자동 폐기 결함을 해소한다.


## 2026-10-07 구조화 오류 수정

- 모든 도구의 MCP 오류 결과에 `ok: false`, `error_code`, `message`, `retryable`을 제공한다. 기존 code/reason/도구별 진단 필드는 보존한다.
- outputSchema는 기존 성공 형태와 공통 실패 형태를 anyOf로 구분한다. 오류에 성공 필수 필드를 요구하지 않으며, 성공 필수 필드 검증도 유지한다.
- Zod 입력 검증은 INVALID_INPUT과 validation_errors(path/code/message)를 반환한다. 검증 전에 인증하던 11개 핸들러는 입력 검증을 먼저 수행하도록 변경했다.
- 없는 파일은 FILE_NOT_FOUND, 디스크 파일 유실은 FILE_MISSING, 크기 초과는 FILE_TOO_LARGE로 반환하며 기존 code도 보존한다.
- 실제 SDK Client + tools/list + InMemoryTransport 회귀 테스트로 최초 오류 7종 및 과제 목록 오류, 백엔드 예외, 시험 학기 오류, 성공 배열/바이너리 전달을 검증했다.
- 전체 테스트 438/438 및 TypeScript 빌드 통과 후, 성공/오류 스키마의 필수 필드가 느슨해지지 않았는지 추가 회귀 테스트를 진행했다.
- 이번 수정 범위는 MCP 오류 계약이다. 시험 파서/원문 덤프 설계와 인증 자동 폐기 결함은 이 변경에서 수정하지 않았다.

## 2026-10-07 추가 변경 검토와 주변 오류 탐색

검토 시점 HEAD는 `7ba2fe2`이고 변경은 아직 작업 트리에 있었다. 앞선 수정 이후 추가된 중첩 진단 집계, 전체 출력 스키마 오류 계약 검증, 사용하지 않는 jsonToolResult 제거를 확인했다. 현재 소스에서 jsonToolResult 참조는 없었다. 기존 SDK 회귀 검증을 포함한 관련 테스트 14개는 추가 수정 전 통과했다.

### 배치의 정상 제외 안내가 실제 오류를 가리는 문제

- **오류 → 탐색:** normalizeToolError는 errors/partial_failures/results 배열을 모두 진단으로 취급하고 첫 message 또는 reason을 선택했다. downloadOne과 downloadMaterialsBatch를 따라가면 results에는 downloaded/skipped뿐 아니라 excluded_video/needs_resolution/not_open 같은 정상 제외도 들어간다. 제외 항목에도 message가 존재한다.
- **원리 분석:** 집계 실패(`ok=false`)라는 사실이 모든 개별 항목의 실패를 의미하지 않는다. 혼합 결과에서 첫 메시지를 고르면 실제 실패 대신 정상 제외 사유가 대표 오류가 되고, 제외 항목의 retryable 값도 오류 집계에 섞인다.
- **해결:** results 배열에서는 `status=failed` 항목만 대표 메시지와 retryable 계산에 사용한다. errors/partial_failures는 기존 진단 의미를 유지한다. 원래 전체 results/summary와 명시적인 최상위 message/retryable도 보존한다.
- **주변 탐색:** 자료 조회의 errors에는 실패 진단이 들어간다. 스냅샷은 부분 실패가 있어도 ok=true로 원문 결과를 제공하므로 정상 응답 정규화는 건드리지 않았다. 배치의 정상 제외만 있는 호출도 계속 성공이다.
- **선제 차단:** 성공/제외/needs_resolution/실패가 섞인 정규화 테스트와 실제 SDK → 서버 → 배치 → 다운로드 경로를 추가했다. 동영상 제외 다음 다운로드 주소 없는 PDF 실패를 넣어 대표 메시지가 `Material has no download locator`이고 results가 excluded_video/failed로 보존되는지 확인했다. 제외만 있는 실제 호출은 ok=true인지 함께 확인했다. 네트워크나 실제 파일 다운로드는 실행하지 않았다.

### 레거시 오류 코드와 객체 기본 속성 충돌

- **오류 → 탐색:** `legacyCodes[details.code]`는 명시적인 매핑 외에도 객체가 상속받은 속성을 조회한다.
- **원리 분석:** code가 constructor/toString/__proto__이면 문자열 대신 함수 또는 객체가 error_code에 들어가 공통 스키마 검증이 원래 오류를 다시 가릴 수 있다.
- **해결:** Object.hasOwn으로 정의된 매핑만 사용하고 나머지 문자열 코드는 그대로 보존한다.
- **선제 차단:** 세 코드 모두 문자열로 보존되고 공통 오류 스키마를 통과하는지 회귀 검증했다.

최종 검증: 전체 테스트 **444/444**, TypeScript 빌드, `git diff --check` 통과. 이번 검토는 구조화 오류 변경 및 인접한 오류 집계 경로에 대한 점검이며, 실제 인증 재발급/폐기나 시험 PDF 파서 재검증은 수행하지 않았다. 커밋·푸시는 하지 않았다.
