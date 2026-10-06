# API 경로

| 기능 | 구현 및 계약 |
| --- | --- |
| SSO·HTTP 쿠키 | `src/http-session.ts` |
| Canvas 토큰·API | `src/canvas-session-tokens.ts`, `src/canvas-client.ts` |
| LearningX 자료실·주차학습 | `src/learningx-client.ts` |
| LTI·게시판 첨부·OCS 문서 | `src/http-materials.ts`, [HTTP 자료 수집](HTTP-MATERIALS.md) |
| 자료 획득 정책·다운로드 | `src/material-acquisition.ts`, `src/tools/download.ts` |
| 과제 조회·제출 | [도구 계약](TOOLS.md) |
| 포털 강의계획서 | `src/oz-client.ts`, `src/tools/syllabus/oz-datasets.ts` |

HTTP 응답의 식별자·목적지·필수 필드를 검증하고, 네트워크 실패와 프로토콜 오류를 구분한다.
과제 제출 UI 보조 및 제출 폼 탐사는 선택 Playwright 의존성을 사용한다.
