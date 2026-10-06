# HTTP 인증 세션

`src/http-session.ts`가 사용자별 쿠키 저장소와 HTTP 요청을 관리한다.
허용 호스트는 `eclass3.cau.ac.kr`, `canvas.cau.ac.kr`, `mportal2.cau.ac.kr`이다.
각 응답의 Set-Cookie를 domain/path/expiry 기준으로 저장하고 리다이렉트 목적지를 검사한다.

## 로그인

1. e-Class 루트에서 SSO 로그인 페이지와 CSRF 쿠키를 받는다.
2. 로그인 폼에 사용자 ID·비밀번호·CSRF 값을 넣어 제출한다.
3. LearningX 응답의 `loginCryption` 인수를 읽고 RSA 블록을 복호화한다.
4. Canvas 로그인 폼을 제출하고 사용자 API로 인증을 확인한다.

원격 JavaScript는 실행하지 않는다. 비밀번호는 자격증명 콜백에서 읽어 폼 제출 동안 사용한다.
쿠키는 사용자별 보안 자격증명 저장소에 보관한다.

## Canvas 토큰

`src/canvas-session-tokens.ts`는 프로필 폼의 authenticity token으로 토큰을 발급하고,
사용자 토큰 목록과 CSRF 인증 DELETE로 발급 실패를 보상한다.
`BrowserSession`은 계정별 토큰 잠금, 캐시 세대 검사, 만료/401 갱신,
발급 결과 유실 시 정확한 토큰 복구, 폐기 대기 ledger를 관리한다.

## 포털

강의계획서 검색은 저장된 HTTP 쿠키를 복구하고 사용자 API로 세션을 확인한다.
mportal의 강의계획서 페이지를 열어 SSO와 JSESSIONID를 확립한 뒤 JSON AJAX를 호출한다.
인증이 만료되면 새 로그인으로 한 번 재시도하며, 갱신된 쿠키를 보안 저장소에 기록한다.
검색에는 Canvas API 토큰 발급이 필요하지 않다.

## 검증

```bash
pnpm exec tsx scripts/probe-http-login.ts
pnpm exec tsx --test test/http-session.test.ts
```

probe는 새 쿠키 저장소로 로그인해 사용자·프로필·포털 현재 학기 조회를 확인한다.
출력에는 인증 판정과 HTTP 상태만 포함한다.

## SSO 페이지 형식

로그인 action은 알려진 form1 JavaScript 대입 또는 login_user_password 필드를
가진 HTML 폼에서 읽는다. 따옴표와 JavaScript 토큰 주변 공백 차이를 허용한다.
Canvas callback의 공백 표현도 처리한다. 로그인 목적지는 canvas의
`/xn-sso/gw-cb.php`, 복호화 후 목적지는 eclass의 POST `/login/canvas`로 검증한다.
알 수 없는 폼·callback·RSA 블록 구조는 SSO_PAGE_CHANGED로 식별한다.
전송 오류와 인증 확인 실패는 별도로 유지한다.
