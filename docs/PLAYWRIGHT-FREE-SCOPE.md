# HTTP 경로 전환 범위

브랜치: `codex/playwright-free`.

## 구현된 경로

| 기능 | 운영 경로 |
| --- | --- |
| 로그인·SSO | `HttpSession`의 쿠키 저장소·redirect·폼 제출·RSA 복호화 |
| Canvas 토큰 | HTTP 발급·목록·CSRF 폐기, 계정 잠금·캐시·401 갱신·보상 ledger |
| 강의계획서 검색 | HTTP SSO → mportal 세션 → 현재 학기·과목/교수 검색 AJAX |
| 강의계획서 본문 | 새 OZ guest 세션 → 데이터 모듈 → schema/record codec → `SyllabusDocument` |

[HTTP-SESSION.md](HTTP-SESSION.md)와 [SYLLABUS.md](SYLLABUS.md)에 구성과 검증 명령을 기록한다.
강의계획서는 에이전트용 구조화 JSON과 전체 원본 데이터 텍스트로 제공한다.

## 남은 전환 범위

- modulebuilder 자료 목록의 LTI·modules JSON 요청.
- courseresource 자료 목록 및 브라우저 보조 경로 정리.
- ExternalTool·LearningX 게시판 첨부 해석.
- OCS 문서 주소 해석과 다운로드.
- 과제 제출 보조 경로의 HTTP 처리와 dry-run·재제출 보호.
- 설치·doctor·discovery 도구 및 package/lockfile의 브라우저 의존성 정리.
- 자료 계약의 `is_playwright_required`와 오탈자 별칭 처리.

각 자료 소스는 목록 누락, 잠금, 실제 파일 형식·확장자·캐시 상태를 검증한다.
최종 완료 기준은 깨끗한 Node 24 환경에서 설치·인증·주요 조회·문서 다운로드,
전체 테스트·빌드, 의존성 재유입 검사가 통과하는 것이다.

## 작업 경계

Cloud MCP 배포, 신규 자료 선택 UI, 캐시 일괄 이전, 영상 스트리밍 지원 확대는 별도 작업이다.
사용자의 `scripts/_live-pl-courses.ts`와 `.commandcode/`는 작업 범위 밖의 로컬 파일로 보존한다.
