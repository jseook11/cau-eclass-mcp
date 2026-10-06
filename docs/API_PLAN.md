# 자료 수집 API 구성

자료 목록·LTI 런치·문서 다운로드는 인증 HTTP 세션과 읽기 API로 처리한다.
현재 엔드포인트, 검증 조건과 실행 방법은 [HTTP 자료 수집](HTTP-MATERIALS.md)에 정리되어 있다.
공개 도구의 입력·출력 및 과제 제출 계약은 [TOOLS.md](TOOLS.md)를 참조한다.

파일 자료와 영상은 각각 파일 다운로드 도구와 `eclass_download_video`를 사용한다.
문서 배치는 영상·interactive·잠금 항목을 획득 정책에 따라 제외한다.
OCS 문서는 XML의 원본 다운로드 locator를 검증하고 같은 인증 세션으로 스트리밍한다.
