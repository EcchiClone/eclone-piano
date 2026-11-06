# EClone Piano — Windows 빠른 시작

1. GitHub Releases에서 Windows x64 **Setup.exe**를 내려받아 실행합니다. 설치 후 시작 메뉴의 **EClone Piano**를 엽니다.
2. ZIP을 선택했다면 모든 파일을 한 폴더에 압축 해제하고 **EClone Piano.exe**를 실행합니다. EXE만 따로 복사하지 않습니다.
3. **데모 미리보기**로 화면을 확인합니다. Node.js·npm·.NET·FFmpeg·Chrome은 따로 설치하지 않아도 됩니다.

지원 환경: 업데이트된 Windows 10 22H2 / Windows 11, x64. 앱은 인터넷 연결 없이 실행할 수 있습니다.

## 실제 연주

MIDI 건반과 드라이버를 준비합니다. 앱에는 피아노 음원이 없으므로 Kontakt와 사용할 악기를 별도로 설치합니다. Kontakt standalone의 MIDI를 앱으로 보내려면 [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html)를 설치합니다.

1. loopMIDI에서 **EClone Piano** 포트를 만들고 실행해 둡니다.
2. Kontakt Options → MIDI: 실제 건반 Input은 켜고, 가상 포트 Input은 Off, 가상 포트 Output은 On.
3. Engine → Send MIDI to outside world에서 **Incoming notes / Incoming CCs**를 켭니다.
4. 앱에서 같은 가상 포트 → **연결**. 건반과 페달을 눌렀다 떼며 노트가 끝나는지 확인합니다.
5. 소리도 녹음하려면 오디오 소스를 선택하고 Kontakt Audio 설정과 동일한 44.1/48kHz를 고릅니다. WASAPI Shared 출력을 사용해 짧은 테스트 녹음의 미터와 재생을 확인합니다.

[자세한 연결 가이드](https://github.com/EcchiClone/eclone-piano/blob/main/docs/SETUP.md)

## 저장·업데이트

설치형과 ZIP 실행 모두 `%APPDATA%\EClone Piano\recordings`에 연주와 설정을 저장합니다. 앱의 **저장 폴더** 버튼으로 열 수 있습니다. ZIP 폴더 안에 기록하는 방식은 아닙니다.

앱을 종료한 뒤 새 Setup.exe를 설치하거나 ZIP의 프로그램 파일을 교체합니다. 사용자 데이터는 유지됩니다. 앱을 제거해도 연주는 자동 삭제하지 않습니다. 백업은 저장 폴더 전체를 복사하세요.

기존 소스 버전 사용자는 앱을 모두 종료하고 프로젝트의 `recordings` 파일들을 위 저장 폴더로 복사할 수 있습니다. 같은 이름의 파일은 먼저 백업하고 덮어쓰기 여부를 결정하세요. 자동 이동은 하지 않습니다.

## OBS와 오버레이

앱을 실행한 상태에서 OBS 브라우저 소스에 `http://127.0.0.1:3210/stage?transparent=1`을 입력합니다. 크기 1920×1080, 프레임률 60으로 설정합니다. 실시간 Kontakt 소리는 OBS의 응용 프로그램 오디오 캡처로 추가합니다.

오버레이는 모니터를 고른 뒤 **데스크톱 오버레이**로 켭니다. **Ctrl+Shift+F10**으로 켜고 끄며, **Ctrl+Shift+F12**로 닫고 스튜디오로 돌아옵니다. 노트·건반 불투명도는 각각 조절합니다.

## 배포 정보

앱의 **오픈소스 라이선스**에서 포함한 구성요소의 고지와 출처를 확인할 수 있습니다. 서명 인증서를 적용하지 않은 배포본이므로 Windows에서 게시자를 확인하지 못했다는 안내가 나올 수 있습니다. 공식 Releases 주소와 SHA256SUMS.txt로 다운로드를 확인하세요.

공식 배포: https://github.com/EcchiClone/eclone-piano/releases
