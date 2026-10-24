# EClone Piano 설치·연결 가이드

[README로 돌아가기](../README.md)

## 1. 필요한 구성부터 고르기

- **데모·화면 확인:** Windows x64, Node.js 22 이상, `npm ci`.
- **실제 MIDI 시각화:** 위 구성 + Windows에서 인식되는 MIDI 입력. Kontakt가 없어도 가능합니다.
- **Kontakt 소리와 MIDI 녹음:** 위 구성 + Kontakt standalone, 가상 MIDI 포트, .NET 9 SDK, 오디오 도우미 빌드.
- **MP4 내보내기:** FFmpeg와 FFprobe 추가. 데스크톱 앱 또는 H.264 WebCodecs 인코딩을 지원하는 Chrome을 사용합니다.
- **방송:** OBS Studio 추가. OBS와 앱을 같은 PC에서 실행합니다. 다른 PC에서 `127.0.0.1` 주소로 접속할 수는 없습니다.

앱은 Windows PowerShell의 WinMM 브리지로 MIDI를 받습니다. Chrome의 Web MIDI 권한이나 별도의 Python 설치는 필요하지 않습니다. macOS·Linux·Windows ARM은 지원 환경으로 검증하지 않았습니다.

## 2. 첫 설치

1. [Node.js](https://nodejs.org/en/download)의 Windows x64 LTS 설치 프로그램을 설치합니다. 최소 Node.js 버전은 22입니다.
2. [소스 ZIP](https://github.com/EcchiClone/eclone-piano/archive/refs/heads/main.zip)을 풀거나 Git으로 복제합니다. 쓰기 권한이 있는 일반 사용자 폴더에 보관하세요. ZIP 안에서 바로 실행하지 않습니다.
3. 파일 탐색기에서 `package.json`이 있는 폴더를 열고, 주소창에 `powershell`을 입력해 그 폴더에서 터미널을 엽니다.
4. `npm ci`로 잠금 파일에 맞는 의존성을 설치합니다. Electron도 이때 내려받습니다.
5. `npm run doctor`로 환경을 확인하고 `npm start`로 앱을 엽니다.

`npm.ps1`이 차단되면 `npm.cmd ci`, `npm.cmd start`처럼 실행할 수 있습니다. 시스템 실행 정책을 바꿀 필요는 없습니다. 설치 프로그램이나 PATH를 추가한 후에는 기존 터미널과 앱을 닫았다가 다시 열어야 새 PATH가 반영됩니다.

### Kontakt 원음 녹음 준비

[.NET 9 다운로드](https://dotnet.microsoft.com/en-us/download/dotnet/9.0)에서 **SDK → Windows → x64**를 설치합니다. Runtime만 설치하면 도우미를 빌드할 수 없습니다. .NET 10 같은 다른 버전만 설치한 경우에도 .NET 9 런타임이 별도로 필요할 수 있습니다.

```powershell
npm run setup
```

이 명령은 `native-audio` 도우미 빌드와 환경 진단을 실행합니다. 도우미는 저장소 안에 생성되며 일반 실행 중 자동으로 컴파일하거나 설치하지 않습니다. `npm run build:audio`로 빌드만 다시 할 수도 있습니다.

### MP4 내보내기 준비

1. [FFmpeg 공식 다운로드 안내](https://ffmpeg.org/download.html)의 Windows 빌드 링크를 이용합니다.
2. 압축을 풀고 **`ffmpeg.exe`와 `ffprobe.exe`가 모두 들어 있는 `bin` 폴더**를 찾습니다.
3. Windows의 **환경 변수 편집 → 사용자 변수 → Path → 편집 → 새로 만들기**에 그 폴더의 전체 경로를 추가합니다. 기존 항목은 지우지 않습니다.
4. 새 터미널에서 확인합니다.

   ```powershell
   ffmpeg -version
   ffprobe -version
   npm run doctor
   ```

FFmpeg 실행 파일을 소스나 Git 저장소에 복사할 필요는 없습니다. 이 프로젝트는 FFmpeg 바이너리를 배포하지 않습니다.

## 3. MIDI 연결 선택

### A. MIDI 건반을 앱에 직접 연결

1. 건반을 USB/MIDI 인터페이스로 연결하고 필요한 제조사 드라이버를 설치합니다.
2. 앱의 **MIDI INPUT** 새로고침을 누릅니다.
3. 해당 장치를 선택하고 **연결**을 누릅니다.
4. 건반·페달을 움직여 이벤트 수와 시각화를 확인합니다.

앱 자체에는 피아노 음원이 없습니다. 건반 자체의 소리를 듣거나 별도의 음원 프로그램이 필요합니다. MIDI 포트를 여러 프로그램에서 동시에 열 수 있는지는 드라이버에 따라 다릅니다. Kontakt와 동시 연결에서 오류가 난다면 아래 가상 포트 방식을 사용하세요.

### B. Kontakt를 거쳐 가상 MIDI 포트로 연결

**loopMIDI 설정**

1. [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html)를 설치합니다. 설치 화면에서 약관을 확인하고 동의하면 설치를 진행합니다.
2. loopMIDI를 실행합니다. `New port-name`에 `EClone Piano`를 입력하고 **+**를 누릅니다.
3. 목록에 해당 이름이 하나 나타나는지 확인합니다. 기본 포트가 추가로 있어도 그 포트를 사용할 필요는 없습니다.
4. loopMIDI를 실행해 둡니다. 설정창을 닫아 트레이로 보내는 것은 괜찮습니다. 트레이에서 앱 자체를 종료하면 포트가 사라집니다.

**Kontakt 설정 — standalone 기준**

| 위치                                                 | 설정                    | 이유                              |
| ---------------------------------------------------- | ----------------------- | --------------------------------- |
| MIDI → Inputs → 실제 MIDI 건반                       | 사용 중인 포트로 활성화 | 연주를 Kontakt가 받음             |
| MIDI → Inputs → EClone Piano                         | **Off**                 | 자기 출력을 다시 받는 순환 방지   |
| MIDI → Outputs → EClone Piano                        | **On**                  | 연주 정보를 앱으로 전달           |
| Engine → Send MIDI to outside world → Incoming notes | **켜기**                | 외장 건반 누름·뗌 전달            |
| 같은 메뉴 → Incoming CCs                             | **켜기**                | 서스테인 등의 컨트롤 전달         |
| 같은 메뉴 → GUI keyboard                             | 선택                    | Kontakt 화면 건반 클릭 전달       |
| 같은 메뉴 → Script generated notes / CCs             | 필요할 때만             | 스크립트·아르페지에이터 출력 전달 |

직접 건반 연주와 스크립트 생성 노트를 함께 보내면 같은 음이 중복될 수 있습니다. 보고 싶은 이벤트 종류만 선택하세요. 사용하지 않는 하드웨어 출력이나 Microsoft GS Wavetable Synth를 켤 필요는 없습니다. [Kontakt 공식 설정 설명](https://docs.native-instruments.com/online-guides/kontakt-manual/en/options-dialog)

**EClone Piano 설정**

1. MIDI 장치를 새로고침합니다.
2. **EClone Piano → 연결**을 선택합니다.
3. 실제 건반을 누르고 떼어 봅니다. 페달을 밟은 채 건반을 놓았다가 페달도 놓아 봅니다.
4. 화면 반응과 loopMIDI의 Total data 증가를 확인합니다. 데이터가 0이면 Kontakt 출력 설정부터 확인합니다.

화면 건반 클릭만으로 외장 건반과 페달 전달까지 확인된 것은 아닙니다. 새 포트가 Kontakt에 없으면 악기 상태를 저장한 뒤 Kontakt를 재실행하세요.

**이전 버전 사용자:** `Luma Piano` 등 기존 포트 이름을 그대로 선택해도 됩니다. 새 포트를 만들거나 기존 포트를 삭제할 필요가 없습니다. 녹음 파일과 설정은 기존 `recordings/`에서 읽습니다.

## 4. 소리 연결과 첫 녹음

1. Kontakt **Options → Audio**에서 출력 장치와 샘플레이트를 확인합니다. 프로세스 오디오 캡처 확인에는 **WASAPI (Shared Mode)**를 사용합니다.
2. EClone Piano의 오디오 소스에서 현재 Kontakt를 선택합니다. 여러 인스턴스가 있으면 녹음하려는 인스턴스를 고릅니다.
3. 샘플레이트를 Kontakt와 동일한 **44,100 Hz 또는 48,000 Hz**로 선택합니다.
4. **Kontakt 소리만 함께 녹음**을 켜고 시작합니다. 준비가 끝나 녹음 시간이 나타나면 짧게 연주합니다.
5. 녹음 입력 미터가 움직이는지 확인한 뒤 종료하고 재생합니다.

오디오 캡처는 선택한 Kontakt 프로세스와 하위 프로세스를 대상으로 합니다. 마이크나 전체 시스템 소리를 대신 녹음하지 않습니다. DAW 플러그인으로 실행한 Kontakt는 별도 Kontakt 프로세스가 없을 수 있어 지원 대상이 아닙니다.

프로세스 캡처의 실제 동작은 Windows 업데이트와 오디오 드라이버에 영향을 받습니다. 현재 확인 환경은 Windows 10 build 19045이며, 다른 환경에서도 첫 녹음의 미터와 WAV를 확인하세요. ASIO·독점 모드는 공유 오디오 엔진을 우회할 수 있습니다. 이런 경우 앱은 전체 시스템 믹스로 자동 전환하지 않습니다.

높은 음량에서 원음 자체가 이미 찌그러지면 Kontakt 출력 레벨을 낮춰 새로 녹음합니다. 샘플레이트 불일치나 손실된 샘플 때문에 생기는 틱은 리미터로 복원할 수 없습니다. 특정 동영상 플레이어에서만 이상하면 다른 플레이어와 비교하고 자체 음량 증폭·효과를 확인하세요.

## 5. 평소 실행과 업데이트

- 실행 순서: **건반 연결 → loopMIDI → Kontakt → EClone Piano**.
- MIDI는 마지막으로 성공한 입력 이름을 기억합니다. 그 이름이 사라졌다면 다른 장치를 임의로 열지 않으므로 목록에서 다시 선택하세요.
- `.vbs` 실행기를 쓸 수 없다면 `npm start`로 실행합니다.
- 종료 전 녹음과 영상 내보내기를 마칩니다. 스튜디오 종료 시 오버레이·로컬 서버도 함께 종료됩니다.
- 업데이트 전 앱을 종료하고 `recordings/`를 백업합니다. Git으로 받은 경우 `git pull --ff-only`, `npm ci`, `npm run setup`을 순서대로 실행합니다. MIDI 전용 사용자는 `npm run setup`을 생략할 수 있습니다. ZIP 설치라면 새 소스 폴더에 기존 `recordings/`를 복사합니다.

[OBS·녹음·오버레이 사용법으로 돌아가기](../README.md#세-가지-사용-방식)
