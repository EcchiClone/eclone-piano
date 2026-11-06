# 검사 구성

| 위치           | 내용                                                          | 실행                   |
| -------------- | ------------------------------------------------------------- | ---------------------- |
| `unit/`        | 피아노 상태·렌더러, MIDI 인코딩, 시계 정렬, 환경 진단         | `npm test`             |
| `integration/` | 가짜 네이티브 프로세스를 사용한 HTTP/WebSocket·녹음·삭제 경합 | `npm test`             |
| `ui/`          | 화면 구성, 투명도, 재생, 여러 창의 소리 출력, 녹음 소스 갱신  | `npm run test:ui`      |
| `export/`      | 합성 원음과 MIDI로 실제 1080p60 MP4 검사                      | `npm run test:export`  |
| `desktop/`     | Electron과 Windows 오버레이 속성                              | `npm run test:desktop` |
| `helpers/`     | 검사에 사용하는 합성 오디오 fixture                           | 개별 실행하지 않음     |

`ui/run.mjs`는 임시 데이터 서버에서 `studio.mjs`를 실행한 다음 나머지 UI 시나리오를 순서대로 실행합니다. `studio.mjs`만 직접 실행하면 운영 데이터가 잘못 사용되지 않도록 거부합니다.

테스트 실행 결과는 `.runtime/reports/`, 스크린샷은 `.runtime/screenshots/`, 자동 정리되는 임시 세션은 `.runtime/tmp/`에 생성됩니다. 브라우저 선택과 결과 디렉터리 설정은 `scripts/lib/`에서 공유합니다. 기존 사용자 연주는 fixture로 사용하지 않습니다.

실제 장치를 사용하는 수동 검사는 [`scripts/diagnostics/`](../scripts/diagnostics/README.md), README 이미지를 생성하는 도구는 [`scripts/docs/`](../docs/images/README.md)에 있습니다.
