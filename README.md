# Luma Piano

Kontakt 7 연주를 위한 로컬 MIDI 시각화 스튜디오입니다. 실시간 상승형 노트, 저장된 연주의 하강형 재생, OBS 투명 브라우저 소스와 바탕화면 오버레이를 지원합니다.

개발 중입니다. 연결과 녹음 검증 결과 및 실행 안내는 기능 검증 후 업데이트합니다.

## 개발

Node.js 22+, Windows, .NET 9 SDK가 필요합니다.

```powershell
npm install
npm run build:audio
npm start
```

브라우저만 사용할 때는 `npm run serve` 후 `http://127.0.0.1:3210`에 접속합니다.
