# HTTP 경로 구성

브랜치: `codex/playwright-free`.

| 기능 | 운영 경로 |
| --- | --- |
| 로그인·SSO | HTTP 쿠키·redirect·폼 제출·RSA 복호화 |
| Canvas 토큰 | HTTP 발급·목록·CSRF 폐기, 계정 잠금·캐시·401 갱신·보상 ledger |
| 강의·공지·과제·성적 조회 | Canvas REST API |
| 강의계획서 검색 | HTTP SSO → mportal AJAX |
| 강의계획서 본문 | OZ guest 데이터 모듈 → `SyllabusDocument` |
| 강의자료실·주차학습 목록 | LearningX LTI 토큰 → HTTP JSON |
| ExternalTool·게시판 첨부 | HTTP 래퍼·LTI 폼·게시판 읽기 API |
| OCS 문서·영상 | XML 메타데이터 → 원본 문서·MP4 스트리밍 |
| 진단·페이지 탐사 | HTTP |
| 과제 제출 | Canvas API와 선택 Playwright UI 보조 |

[HTTP-SESSION.md](HTTP-SESSION.md), [HTTP-MATERIALS.md](HTTP-MATERIALS.md),
[SYLLABUS.md](SYLLABUS.md)에 구성과 검증 명령이 있다.

Playwright의 런타임 로드는 과제 제출 UI와 그 dry-run 폼 탐사로 한정한다.
Chromium은 기본 설치에서 내려받지 않으며 필요 시 `pnpm run install:browser`로 준비한다.

Cloud MCP 배포, 신규 자료 선택 UI, 캐시 일괄 이전, 영상 스트리밍 지원 확대는 별도 작업이다.
사용자의 `scripts/_live-pl-courses.ts`와 `.commandcode/`는 로컬 파일로 보존한다.
