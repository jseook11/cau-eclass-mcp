# ExternalTool acquisition contract

프로그래밍 04분반의 `3736209 / Chapter 5`처럼 Canvas ExternalTool 래퍼를 파일로 다운로드하다 실패하는 반복을 막기 위한 계약이다. `ExternalTool`은 전달 방식이고, 자료의 의미 유형은 아래 필드로 구분한다.

## MCP 반환값

`eclass_get_materials`는 모든 항목에 다음 필드를 반환한다.

| 필드 | 값과 의미 |
|---|---|
| `asset_kind` | `document`, `video`, `interactive`, `unresolved` |
| `downloadable` | 파일 acquisition이 허용되는 문서인 경우에만 `true` |
| `acquisition_policy` | `download`, `exclude`, `needs_resolution`, `not_open` |
| `resolution_reason` | 분류 근거 또는 미확인 원인 코드 |
| `fingerprint` | 원본 ID·제목·type·URL·외부 URL·모듈명·잠금 정보의 SHA-256 |

기본 조회는 추가 LTI launch를 하지 않는다. 같은 module item ID로 확인된 modulebuilder의 PDF/movie 정보, Canvas 파일 정보와 직접 파일·영상 대상 URL을 사용한다. 모듈명 `Online lecture` 또는 제목 `Chapter 5`만으로 영상이라고 판정하지 않는다. `https://ocs.cau.ac.kr/em/<id>`도 PDF 뷰어와 동영상 플레이어가 공유하므로 URL만으로 문서라고 판정하지 않는다.

보고서의 래퍼가 다른 source에서 의미 유형을 확인할 수 없다면 아래처럼 반환한다. 별도 PDF `3736210`의 성공이나 비슷한 제목은 이 항목의 판정에 사용하지 않는다.

```json
{
  "id": "3736209",
  "type": "ExternalTool",
  "asset_kind": "unresolved",
  "downloadable": false,
  "acquisition_policy": "needs_resolution",
  "resolution_reason": "semantic_type_unknown"
}
```

필요할 때 `eclass_get_materials({ course_id, sources: ["external"], resolve_external: true })`로 미확인 래퍼의 LTI launch를 확인할 수 있다. 확인된 파일 응답/첨부는 문서로, OCS 메타데이터의 `content_type`(예: `movie`, `everlec`)이나 영상/스트리밍 MIME 응답은 영상으로 판정한다. 파일을 디스크에 저장하거나 영상 재생 완료를 기다리지 않는다. `content_type=sharedocs` 뷰어는 원본 문서, 구형 type-17 File 뷰어는 원본 파일로 해석하고, 그 밖에 판단할 수 없는 뷰어만 `ocs_viewer_type_unknown`으로 남긴다.

`resolution_retryable`, `resolution_error_code`, `resolution_debug`는 추가 확인 결과에 붙는다. HTTP 401/429/5xx와 timeout/network 오류는 재확인 대상으로 남기고, 파일 미확인은 `EXTERNAL_TOOL_NO_ARTIFACT`로 반환한다. debug는 URL의 query/hash를 제거하고 500자로 제한한다. 자료 목록 자체의 `ok`/`errors`는 source 조회 성공 여부를 나타내며, 개별 미확인을 source 전체 실패로 집계하지 않는다.

Canvas `state: locked`, `unlock_at`, item의 `content_details.locked_for_user`를 반영해 `not_open`을 반환한다. Modules API에 `include[]=items`와 `include[]=content_details`를 함께 요청한다. 필드 의미는 [Canvas Modules API](https://developerdocs.instructure.com/services/canvas/resources/modules)에 따른다. modulebuilder의 기존 `not_open` placeholder 제외 동작은 유지한다.

잠긴 Canvas ExternalTool은 목록에 보존하며 `downloadable: false`, `acquisition_policy: not_open`으로 내려보낸다. 모듈과 항목의 unlock_at 및 병합된 별칭의 unlock_at 중 가장 늦은 유효 시각을 적용한다. 따라서 자식 항목의 과거 날짜가 부모 모듈의 미래 잠금을 해제하지 않는다. 파일 다운로드 결과도 `not_open`, `retryable: false`이므로 다운로드 실패로 집계하지 않는다.

공지 provenance도 원본 ID로 보존한다. 공지 조회 결과의 필수 `course_id`는 조회 과목을 나타내며, 공지 첨부 material의 `announcement_id`는 원본 공지를 나타낸다. 다른 source가 대표가 되더라도 이 관계를 유지하고, 같은 파일이 여러 공지에 재사용되면 `announcement_ids`로 모든 관계를 반환한다. JSON snapshot도 해당 필드를 그대로 포함한다.

## 다운로드 결과

단일/배치 다운로드 입력에는 위 분류 필드와 `module_name`, `external_url`, `locked_for_user`, `unlock_at`을 전달할 수 있다. 단일 호출에서는 `id → file_id`, `title → display_name`을 매핑한다. 명시적인 비파일 정책은 캐시 확인·LTI launch·파일 다운로드보다 먼저 처리한다. 이전 클라이언트처럼 분류 필드 없이 ExternalTool을 호출하면 실제 LTI 확인을 수행하되, 파일 미확인 결과를 재시도 가능한 다운로드 실패로 변환하지 않는다.

| 결과 `status` | 실패 집계 | 다음 동작 |
|---|---|---|
| `downloaded` | 아니오 | 파일 검증 후 분석 큐 등록 |
| `skipped` | 아니오 | 정확한 ID/과목의 기존 파일 검증 후 분석 큐 등록 |
| `excluded_video` | 아니오 | 문서 수집 정책에서는 제외 |
| `excluded_interactive` | 아니오 | 제외 |
| `not_downloadable` | 아니오 | 제외 |
| `needs_resolution` | 아니오 | 파일 다운로드 금지; 별도 확인 대상 |
| `not_open` | 아니오 | 열림 상태를 다음 source 조회에서 확인 |
| `failed` + `failure_kind: failed_retryable` | 예 | `retry_with_backoff` |
| `failed` + `failure_kind: failed_terminal` | 예 | 자동 재시도하지 않음 |

제외/미확인/잠김 결과는 MCP `isError`가 false이고 `retryable: false`이다. 실제 실패는 `isError: true`와 JSON `{ ok: false, status, error_code, message, retryable, failure_kind, next_action, file_id, display_name, strategy }`를 반환한다. 과거 단일 다운로드의 비구조화 오류 문자열에서 변경된 부분이다.

성공 다운로드는 기존 `local_path`, `size_bytes`, `skipped` 필드를 유지하고 `status`를 추가한다. 비파일 결과에는 `local_path`가 없다. 배치 `summary`는 `excluded`, `needs_resolution`, `not_open`을 추가하며 `failed`에는 실제 실패만 포함한다. `continue_on_error: false`도 실제 실패에서만 중단한다. `ok: true`가 모든 항목의 파일 확보를 뜻하지 않으므로 반드시 개별 status를 확인한다.

제목 또는 로컬 크기를 근거로 다른 source ID에 캐시를 재연결하지 않는다. 파일 캐시는 과목과 ID, 알려진 source가 일치해야 한다. 새 파일은 과목/ID hash별 디렉터리에 저장해 같은 제목의 서로 다른 자료가 파일을 덮어쓰지 않게 한다. 기존 경로의 캐시 파일은 그대로 읽을 수 있다.

## 저장된 LTI 확인 결과

MCP의 `material_resolutions` SQLite 테이블은 `(course_id, file_id, fingerprint)`에 따라 분류, sanitized reason, 오류 코드, 재시도 여부, locator, `observed_at`, `attempt`를 저장한다. 비재시도 결과는 재시작 후에도 재사용하며, fingerprint가 달라지면 재확인한다. 일시적 오류는 비재시도 결과로 재사용하지 않는다. `resolved_locators`도 과목과 fingerprint가 일치할 때만 재사용한다.

이 테이블은 MCP의 LTI 확인 캐시다. Collector acquisition 전체의 실행 이력, backoff 스케줄, immutable artifact, 분석 큐는 VPS Collector가 관리해야 한다.

## VPS Collector에 반영할 변경

1. 자료의 `type`, 제목, 모듈명 대신 `downloadable === true && acquisition_policy === "download"`인 항목만 파일 acquisition에 넘긴다.
2. `exclude`, `needs_resolution`, `not_open`은 source snapshot에 유지하고 정상 결과로 ledger에 기록한다. 같은 fingerprint의 제외/미확인을 다음 실행에서 added로 만들지 않는다. 영상과 interactive는 `excluded_video`/`excluded_interactive`로, 미확인은 `needs_resolution`으로 기록한다.
3. 추가 LTI 확인이 필요한 항목은 파일 다운로드와 분리한다. `resolve_external: true` 결과의 `resolution_retryable: true`이면 backoff 후 재확인하고, 비재시도 미확인은 metadata 변경 또는 명시적 재검토 전까지 재시도하지 않는다.
4. 실제 다운로드 실패는 `retryable`과 `failure_kind`로 나눈다. snapshot을 모든 실패에서 삭제하는 규칙을 없애고, 재시도 대상은 durable queue/ledger에서 관리한다. MCP는 backoff 시간을 예약하지 않는다.
5. run manifest 및 acquisition ledger에 `course_id`, source-native identity, `fingerprint`, `attempt`, `status`, `reason`, `retryable`, `observed_at`, `next_action`을 남긴다. `{ identity: "course:147845/materials:id:3736209" }`처럼 원본 ID를 보존한다. 오류 원문은 MCP의 sanitized `message`/`resolution_debug`를 보존한다.
6. `downloaded` 또는 검증된 `skipped` 결과만 immutable artifact로 고정한 뒤 분석 큐에 전달한다. `ok: true`만으로 enqueue하지 않는다.
7. 다른 ID의 제목 유사성이나 PDF 다운로드 성공을 래퍼 실패의 해결 근거로 사용하지 않는다. 관계가 별도 증거로 확인되면 `related_material`로 기록한다.

이 저장소 변경은 VPS Collector 수정이나 운영 배포를 포함하지 않는다. 실제 `3736209`를 파일/영상으로 확정하려면 새 MCP의 source 조회 또는 선택적 LTI 확인 결과가 필요하다.

## 회귀 검증

`test/material-acquisition.test.ts`와 관련 get-materials/download/LTI 테스트가 제목·모듈명에 의존하지 않는 분류, PDF 확인, 비파일 다운로드 미호출, 잠금 처리, 일시적 HTTP 오류, DB 재시작 후 미확인 재사용, metadata 변경 시 재확인, 동일 제목의 별도 ID와 파일 보존을 검증한다. 운영 Collector state는 소비하지 않는다.
