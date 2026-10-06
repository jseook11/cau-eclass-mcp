# 강의계획서 데이터 경로

강의계획서는 검색 후보와 구조화된 본문으로 제공한다.

## 검색

`src/mportal-client.ts`의 `searchSyllabusList`는 사용자 HTTP SSO 세션으로
mportal의 `selectCurYear.ajax`, `selectList.ajax`를 호출한다.
검색 결과의 year/term/campus_code/sust_code/course_code/section을 본문 조회에 전달한다.

## 본문

`src/oz-client.ts`는 `https://rpt80.cau.ac.kr/oz80/server`에 새 guest 세션을 생성하고
`pUskLei008.odi`의 학기·캠퍼스·학과·학수번호·분반 데이터 모듈을 요청한다.
응답의 기본정보에서 요청한 여섯 식별자가 일치하는지 확인한다.

`src/oz-protocol.ts`는 메시지 헤더, 그룹 schema, record offset/length와
SQL 타입별 값을 디코딩한다. 그룹 메타와 내부 데이터셋별 행을 보존한다.
CAU wire profile은 17개 환경 필드, `rv=268435456`, `fd=''`, 가변 길이 프레임,
`[2,32,17,0,0]` trailer를 사용한다. version byte는 메타데이터로 보존한다.

codec은 [OZRA](https://github.com/EATSTEAK/ozra/tree/9c6da3b9ab1169c3ac0b136625234e0d3553d07a)의
MIT 구현을 참고했다. 라이선스 고지는 `third-party/ozra-LICENSE.txt`에 있다.

## 출력

`src/tools/syllabus/oz-datasets.ts`가 `SyllabusDocument`로 매핑한다.
기본정보·교수자·목표·교재·평가·주차일정을 제공하며 빈 값은 null이다.
주차는 SEQ 순서로 정렬한다. 가로 공백을 정규화하고 문단 개행은 보존한다.
주차별 학습과제는 PROJ, 추가설명은 ADDEXP에 연결된다.

`raw_text`에는 그룹명과 원본 데이터의 JSON 텍스트를 담는다.
수업 방식·과제 등 구조화 필드에서 다루지 않은 내용도 포함한다.
OZParam의 요청 값은 제외한다. 클라이언트는 이 필드를 일반 원문 텍스트로 취급한다.

실패 코드는 `SYLLABUS_INVALID_INPUT`, `SYLLABUS_NOT_FOUND`,
`SYLLABUS_IDENTITY_MISMATCH`, `SYLLABUS_TRANSPORT_FAILED`,
`SYLLABUS_PROTOCOL_FAILED`, `SYLLABUS_MAPPING_FAILED`, `SYLLABUS_INTERNAL_ERROR`이다.

## 검증

```bash
pnpm exec tsx scripts/probe-oz-syllabus.ts 2026 S 1 3B410 15841 01 /tmp/syllabus-new.json
pnpm exec tsx --test test/oz-protocol.test.ts test/oz-datasets.test.ts test/oz-client.test.ts
```

probe는 운영 호출부를 실행하고 새 파일에만 JSON을 저장한다(권한 0600).
성공 로그에는 식별자 일치 판정과 교재·평가·일정 개수만 포함한다.

## 선수과목 표시 조건 확인 (2026-10-06)

guest repository HTTP 요청으로 `/TIS/prof/usk/pUskLei008.ozr` 원본을 확인했다.
DataBand10의 Table15/TableValue1은 SELLABEL/COLNAME 모두 PRESBJT다.
선수과목 밴드와 헤더에는 조건 이벤트가 없으며 보고서 전체에 PRESBJTFG 참조도 없다.
따라서 플래그와 무관하게 PRESBJT를 직접 매핑한다. 빈 값은 null이다.
확인한 압축 해제 OZR의 SHA-256:
`a0b9627798ca1da95754db11d2c0ea955b5e19f868999c3a27b7b4c0e2d4891d`.
원본 보고서는 저장소에 포함하지 않는다.

본문 조회는 여섯 식별자를 모두 필수로 받는다. 전송·프로토콜·매핑 실패를
각 단계에서 구분하며 원본 예외의 서버 메시지·세션 값은 반환하지 않는다.
전송 실패는 일시적인 통신 문제를 확인한 후 재시도한다. 프로토콜·매핑 실패는
응답 형식과 구현 점검 대상이다. 호출부의 예상하지 못한 오류는
SYLLABUS_INTERNAL_ERROR로 구분한다.
문자열 필드는 실제 schema 변화 근거가 확인될 때까지 string/number/null 검증을
유지한다. 잘못된 평가 비율과 중복 주차는 매핑 실패로 처리한다.
