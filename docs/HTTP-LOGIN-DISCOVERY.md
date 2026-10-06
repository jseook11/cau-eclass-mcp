# e-Class 로그인·SSO를 HTTP로 재현한 과정

작업일: 2026-10-05 (Asia/Seoul)

## 결론

아이디·비밀번호 입력부터 SSO 쿠키 발급, Canvas 로그인 완료까지 HTTP 요청만으로 성공했다.
Chromium을 실행하지 않고, 기존 브라우저 쿠키나 저장된 세션도 불러오지 않았다.
새 쿠키 저장소로 시작해 `/api/v1/users/self`와 `/profile/settings`를 모두 200으로 조회했다.

핵심은 SSO 로그인 POST 이후에 **LearningX가 내려주는 Canvas 로그인 폼을 한 번 더 제출하는 것**이다.
이 폼의 비밀번호 값은 페이지에 있는 RSA 암호문과 개인키로 복호화해서 채운다.
학교의 `login-cryption.js`가 하던 계산과 폼 제출을 Node 코드로 옮겼다.

따라서 로그인·SSO 쿠키 발급을 위해 상시 브라우저 서버를 운영할 필요가 없다.

## 조사 출발점

기존 `src/browser-session.ts`의 `loginToEclass()`는 다음 순서로 로그인한다.

1. `https://eclass3.cau.ac.kr`로 이동한다.
2. `login_user_id`, `login_user_password` 입력창을 채운다.
3. `page.evaluate('OnLogon()')`을 실행한다.
4. 이동이 끝난 뒤 e-Class 호스트에 도착했는지 확인한다.

여기서 브라우저가 수행하는 실제 통신과 JS 계산을 찾아 HTTP 코드로 재현하는 것이 이번 작업의 목적이었다.
ChatGPT용 원격 MCP에서 브라우저 실행 비용과 배포 의존성을 줄이려는 논의에서 시작했다.

## 사용한 코드와 실행 방법

검증 코드: [`scripts/probe-http-login.ts`](../scripts/probe-http-login.ts)

```bash
pnpm exec tsx scripts/probe-http-login.ts
```

- `resolveDoctorCredentials()`로 기존 설정의 사용자 계정을 찾는다.
- `getEclassPassword()`로 기존 자격증명 저장소의 비밀번호를 읽는다.
- `request.newContext()`로 새 HTTP 클라이언트와 쿠키 저장소를 만든다.
- Playwright 패키지의 `APIRequestContext`만 사용한다. `chromium.launch()`나 페이지 객체는 사용하지 않는다.
- `storageState()`는 메모리의 쿠키를 읽는 데 사용한다. 세션 파일을 불러오거나 저장하지 않는다.
- 로그인 완료 후 사용자 API와 설정 페이지를 읽는다. Canvas API 토큰을 새로 생성하지 않는다.
- 실행이 끝나면 HTTP 컨텍스트를 폐기한다.

Playwright의 HTTP 클라이언트를 택한 이유는 저장소에 이미 설치돼 있고 쿠키 처리를 제공하기 때문이다.
브라우저 없는 요청 흐름을 먼저 확인했으며, 일반 HTTP 클라이언트와 CookieJar로 옮길 대상도 명확해졌다.

## 성공한 요청 순서

| 순서 | 요청 | 응답 | 처리 |
| --- | --- | --- | --- |
| 1 | `GET eclass3.cau.ac.kr/` | 302 | 초기 Canvas 쿠키를 받고 `/login`으로 이동 |
| 2 | `GET eclass3.cau.ac.kr/login` | 302 | Canvas SSO 게이트웨이로 이동 |
| 3 | `GET canvas.cau.ac.kr/xn-sso/gw.php` | 302 | 로그인 구분 쿠키를 받고 로그인 페이지로 이동 |
| 4 | `GET canvas.cau.ac.kr/xn-sso/login.php` | 200 | 로그인 HTML과 `xn_sso_csrf_token_for_this_login` 쿠키 확보 |
| 5 | `POST canvas.cau.ac.kr/xn-sso/gw-cb.php` | 302 | 아이디·비밀번호 인증 후 `ssotoken` 발급 |
| 6 | `GET eclass3.cau.ac.kr/learningx/login` | 200 | Canvas 로그인 폼, RSA 암호문과 개인키 확보 |
| 7 | `POST eclass3.cau.ac.kr/login/canvas` | 302 | 복호화한 값을 폼에 넣어 Canvas 로그인 |
| 8 | `GET eclass3.cau.ac.kr/` | 200 | 로그인된 e-Class 페이지 도착 |
| 9 | `GET eclass3.cau.ac.kr/api/v1/users/self` | 200 | 인증된 사용자 정보 확인 |
| 10 | `GET eclass3.cau.ac.kr/profile/settings` | 200 | 로그인된 설정 페이지 확인 |

리다이렉트는 `maxRedirects: 0`으로 자동 추적을 끄고, 응답의 `Location`을 읽어 직접 따라갔다.
301·302 응답에서 POST는 GET으로 전환했고, 303도 GET으로 전환했다. 307·308은 메서드와 바디를 유지한다.
각 응답의 쿠키는 같은 HTTP 컨텍스트에 누적된다.

HTML 요청에는 `Accept: text/html`을 사용했다.
폼 POST에는 `Content-Type: application/x-www-form-urlencoded`와 앞 페이지의 `Referer`, `Origin`을 보냈다.

## OnLogon()에서 확인한 내용

공개 로그인 페이지의 `OnLogon()`은 다음 작업만 수행했다.

1. 아이디와 비밀번호가 빈 값인지 검사한다.
2. `xn_sso_csrf_token_for_this_login` 쿠키 값을 `csrf_token` 입력 필드에 넣는다.
3. 폼 action을 다음 URL로 설정한다.
4. 폼을 POST한다.

```text
https://canvas.cau.ac.kr/xn-sso/gw-cb.php
  ?from=web_redirect
  &login_type=standalone
  &return_url=https%3A%2F%2Feclass3.cau.ac.kr%2Flearningx%2Flogin
```

POST 바디의 필드는 다음 세 가지다.

```text
csrf_token
login_user_id
login_user_password
```

이 요청이 성공하면 `.cau.ac.kr` 도메인 범위의 `ssotoken`이 발급된다.
같은 쿠키 저장소를 사용하므로 이후 `eclass3.cau.ac.kr` 요청에도 이 쿠키가 전달된다.

## LearningX → Canvas 로그인 연결

SSO 다음 페이지인 `/learningx/login`에는 다음 리소스가 있었다.

```text
/learningx/lib/jsencrypt/jsencrypt.min.js
/learningx/js/login-cryption.js
```

`login-cryption.js`의 실제 로직은 다음 순서였다.

```text
window.loginCryption(암호문, 개인키)
  → JSEncrypt.setPrivateKey(개인키)
  → JSEncrypt.decrypt(암호문)
  → pseudonym_session_password 입력 필드에 복호화 결과 설정
  → login_form.submit()
```

폼 action은 `https://eclass3.cau.ac.kr/login/canvas`이고 method는 POST였다.
폼 필드는 다음과 같았다.

```text
utf8
redirect_to_ssl
after_login_url
pseudonym_session[unique_id]
pseudonym_session[password]
pseudonym_session[remember_me]
```

검증 코드에서는 `window.loginCryption()`의 두 문자열 인수만 파싱했다.
반환된 JavaScript 전체를 실행하지 않고, 기존 `parseLtiForm()`으로 폼 필드와 action을 추출했다.
복호화 결과를 `pseudonym_session[password]`에 넣고 나머지 필드와 함께 POST했다.

학교가 내려준 개인키는 **PEM 헤더·본문·푸터가 줄바꿈 없이 이어진 문자열**이었다.
헤더·본문·푸터 사이에 줄바꿈을 넣어 Node/OpenSSL이 읽을 수 있는 PEM으로 정규화했다.

RSA 처리는 `node:crypto`의 `privateDecrypt()`에 `RSA_NO_PADDING`을 지정하고,
복호화된 PKCS#1 v1.5 블록의 `00 02 … 00` 구조를 검사한 뒤 마지막 구분자 이후의 값을 사용했다.
코드는 구분자 앞 패딩 길이도 확인한다. 이 경로는 학교 페이지의 JSEncrypt 복호화 동작을 재현한다.

## 실패한 시도와 수정

| 시도 | 관찰한 결과 | 원인과 수정 |
| --- | --- | --- |
| 기본 `curl`로 e-Class 루트 조회 | 401과 `사용자 인증 필요` JSON이 반환됐다 | `Accept: text/html`을 지정하자 로그인 리다이렉트와 HTML을 얻었다 |
| `OnLogon()` POST와 HTTP 리다이렉트까지만 구현 | `ssotoken`은 발급됐지만 사용자 API는 404, 설정 페이지는 다시 SSO 로그인으로 이동했다 | `/learningx/login`의 200을 최종 로그인 완료로 취급했다. 이 페이지의 Canvas 로그인 폼 제출이 추가로 필요했다 |
| `.submit()` 호출이 있는 자동 POST 폼만 찾는 처리 | `/learningx/login` 폼이 실행되지 않았다 | HTML은 `window.loginCryption()`을 호출하고, `.submit()`은 외부 JS 안에 있었다. 해당 JS를 읽고 복호화와 폼 제출을 직접 구현했다 |
| 전달받은 개인키를 그대로 Node RSA 복호화에 사용 | `ERR_OSSL_UNSUPPORTED` | 개인키 문자열이 OpenSSL에서 읽히지 않았다. 키 표현을 조사했다 |
| PEM 헤더가 없는 키에 헤더를 붙이는 분기 추가 | 같은 `ERR_OSSL_UNSUPPORTED` | 실제 키에는 이미 `BEGIN RSA PRIVATE KEY` 헤더가 있었다. 헤더 유무가 원인이 아니었다 |
| 문자열의 `\\n`, `\\r` 이스케이프를 실제 줄바꿈으로 변환 | 같은 `ERR_OSSL_UNSUPPORTED` | 실제 키에 줄바꿈과 해당 이스케이프가 없었다. 헤더·본문·푸터를 분리해 줄바꿈을 직접 넣으니 복호화가 성공했다 |
| 사용자 API의 `login_id`·`sis_user_id`로 계정 일치 판정 | API와 설정 페이지는 모두 200인데 `identity_matches: false`로 스크립트가 실패했다 | 응답에 비교할 식별자 필드가 없었다. 필드가 없으면 `null`, 있으면 실제 값으로 비교하도록 수정했다. 인증 성공은 사용자 `id`·`name`과 설정 페이지로 확인했다 |

중간 진단에서 form 태그 전체를 출력하니 `onsubmit` 속성의 암호화된 SSO 값까지 출력됐다.
이 진단 출력을 제거했다. 필요한 구조를 조사할 때는 입력 필드 이름, JS 경로, 쿠키 이름·범위,
키 인코딩의 형태와 길이만 출력했다. 최종 스크립트는 HTTP 상태, 호스트·경로, 쿠키 이름과 성공 판정만 출력한다.

## 최종 실행 결과

`pnpm exec tsx scripts/probe-http-login.ts`가 종료 코드 0으로 완료됐다.

```json
{
  "browser_launched": false,
  "existing_session_loaded": false,
  "api_self_status": 200,
  "authenticated_self": true,
  "identity_matches": null,
  "authenticated_settings": true
}
```

`identity_matches: null`은 사용자 API에 `login_id`·`sis_user_id`가 없어서 문자열 비교를 생략했다는 뜻이다.
`authenticated_self`는 사용자 API가 200으로 반환한 `id`와 `name`을 확인한 결과다.
`authenticated_settings`는 설정 페이지가 200이고 최종 경로가 `/profile/settings`이며 로그인 폼이 없는지 확인한 결과다.

최종 쿠키 저장소에는 다음 쿠키들이 있었다. 값은 기록하지 않았다.

```text
_csrf_token
log_session_id
_legacy_normandy_session
_normandy_session
NCPVPCLB
ssotoken
XSRF-TOKEN
laravel_session
```

## 구현 방향과 다음 작업

로그인 부분은 다음 구성으로 옮길 수 있다.

```text
일반 HTTP 클라이언트 + 사용자별 CookieJar
  → OnLogon 폼 POST
  → SSO 리다이렉트
  → RSA 복호화 + Canvas 폼 POST
  → 인증 세션 재사용
```

현재 추가한 파일은 개발용 로그인 검증 스크립트다. 기존 `BrowserSession`의 로그인 구현은 그대로 있다.
후속 작업은 이번 요청 흐름을 재사용 가능한 HTTP 세션 모듈로 추출하고, 다음 세 경로를 같은 세션으로 조사하는 것이다.

1. `external_tools/211`에서 modulebuilder 강의자료 목록 가져오기.
2. ExternalTool의 LTI POST·iframe·리다이렉트를 따라 파일 또는 OCS 뷰어 주소 찾기.
3. OCS 뷰어의 파일 요청을 재현해 문서 다운로드하기.

앞선 코드 조사에서 `courseresource` 목록은 이미 Canvas `sessionless_launch` → LTI 폼 POST →
`xn_api_token` → LearningX JSON 요청 경로를 사용하고 있었다. 이 구현도 함께 재사용할 수 있다.

관련 코드:

- [`src/browser-session.ts`](../src/browser-session.ts): 기존 브라우저 로그인과 세션 관리.
- [`src/learningx-client.ts`](../src/learningx-client.ts): LTI 폼 파서와 HTTP 기반 LearningX 접근.
- [`src/doctor.ts`](../src/doctor.ts): 설정된 계정 찾기.
- [`src/secrets.ts`](../src/secrets.ts): 기존 자격증명 저장소에서 비밀번호 읽기.
