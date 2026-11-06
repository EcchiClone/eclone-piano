# 수동 진단 도구

이 폴더는 개발 중 실제 장치나 원본 WAV를 확인할 때 사용하는 도구입니다. 일반 실행·자동 테스트·CI에서는 호출하지 않습니다. 프로젝트 루트에서 실행합니다.

| 명령                                                       | 동작                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run diagnose:midi`                                    | 실제 MIDI 장치 목록과 브리지 오류·종료 처리를 확인합니다. 노트를 전송하지 않습니다. |
| `npm run diagnose:audio -- <Kontakt PID>`                  | 현재 Kontakt를 약 1초간 임시 녹음하고 WAV 형식을 확인한 뒤 임시 파일을 지웁니다.    |
| `npm run analyze:wav -- <file.wav>`                        | 기존 PCM16 stereo WAV의 peak·클리핑·무음·파형 급변을 읽기 전용으로 분석합니다.      |
| `node scripts/diagnostics/capture-audio.mjs <Kontakt PID>` | 실행 중인 스튜디오에서 녹음이 진행 중인지 확인하고 최대 6초 진단 캡처를 만듭니다.   |

오디오 캡처는 빌드된 도우미와 호환되는 Windows/Kontakt가 필요합니다. PID가 여러 개면 녹음하려는 인스턴스를 명시하세요. 캡처 도구의 WAV와 상세 JSON은 `.runtime/tmp/`에 남으며 필요할 때 직접 보관합니다.

[오디오 도우미](../../native/audio/README.md) · [프로젝트 개발 가이드](../../docs/DEVELOPMENT.md)
