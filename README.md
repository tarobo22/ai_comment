# 운명원 댓글 스튜디오

YouTube 링크로 공개 영상과 댓글을 읽고, 선택한 원댓글에 맞는 AI 답글과 게시 결과를 관리하는 로컬 앱입니다.

## Windows에서 바로 실행

**[AIComment.exe 다운로드](https://github.com/tarobo22/ai_comment/raw/refs/heads/main/dist/AIComment.exe)**

1. 다운로드한 **AIComment.exe**를 더블클릭하세요. 첫 실행은 실행 파일을 준비하느라 잠시 걸릴 수 있습니다.
2. 브라우저에서 댓글 스튜디오가 열립니다. 영상과 댓글을 조회하려면 PC에 Google Chrome이 설치되어 있어야 합니다.
3. AI로 글을 처음 만들 때 화면 상단의 **Gemini 설정**을 누르고 [Google AI Studio](https://aistudio.google.com/apikey)에서 발급한 키를 붙여넣어 저장하세요. 키는 현재 Windows 계정에 암호화해 저장됩니다.

Windows x64용이며 Node.js와 Playwright가 들어 있습니다. 사용을 마치면 작업 표시줄 오른쪽의 스튜디오 아이콘에서 **댓글 스튜디오 종료**를 누르세요.

## 사용

1. **영상 선택**에서 최근 연애 영상 목록을 불러오거나 YouTube 링크를 붙여넣습니다. **영상 분석**을 실행하면 자막 근거와 시간대가 표시됩니다. 자막을 읽을 수 없으면 제목·설명을 사용합니다. 운명원 포지션은 이 단계에서 입력합니다.
2. **댓글 대상**에 들어가 공개 댓글을 불러온 뒤 답글을 만들 원댓글을 고릅니다.
3. **AI로 글 작성하기**에서 말투 유형(중립·여성 말투·남성 말투), 말투 온도와 답변 방향을 선택합니다. 두 버전 모두 **영상 · 공감 · 운명원 연결** 순서로 표시합니다. 분위기가 밝은 댓글의 표현을 살린 버전에는 `ㅋㅋ`나 `ㅎㅎ`가 들어갈 수 있습니다. 원하는 버전을 선택해 문구를 수정하거나 설정을 바꿔 재생성합니다.
4. **실행하기**에서 확정한 답글을 게시하고 기록을 확인합니다. 직접 게시한 답글은 **게시 확인**으로 기록할 수 있습니다.

게시 준비에는 운명원 언급, 40~120자, 링크·해시태그 금지 규칙을 적용합니다. 영상당 1개, 한국 시간 기준 하루 10개를 이 앱에서 공통 적용합니다. 공개 화면에서 답글을 확인하기 어려운 작업은 확인 보류에 남고 기록 화면에서 다시 확인할 수 있습니다.

### Chrome에서 한 글자씩 게시하기

최초 한 번 설정합니다.

1. 작업 표시줄 오른쪽의 스튜디오 아이콘에서 **Chrome 확장 폴더 열기**를 누릅니다.
2. 댓글을 달 YouTube 계정으로 로그인한 Chrome에서 주소창에 `chrome://extensions`를 입력합니다.
3. **개발자 모드**를 켜고 **압축해제된 확장 프로그램을 로드합니다**를 눌러 방금 열린 `chrome-extension` 폴더를 선택합니다.
4. 같은 Chrome 프로필에서 [스튜디오](http://localhost:5000/)를 열고 **04 실행하기 → Chrome에서 게시**를 사용합니다.

### AI 설정과 기록

AI 작성에는 Gemini 3.1 Flash-Lite를 사용합니다. 영상 정보와 분석 근거, 선택한 원댓글, 작성 설정과 운영자 입력이 초안 생성에 사용됩니다. [Gemini 사용량 및 요금](https://ai.google.dev/gemini-api/docs/pricing/#gemini-3.1-flash-lite)

EXE로 실행한 게시 기록은 `%LOCALAPPDATA%\UnmyeongwonStudio\data`에 보관됩니다.

<details>
<summary>소스에서 실행하기</summary>

Node.js 24 이상과 Chrome을 설치합니다.

```sh
git clone https://github.com/tarobo22/ai_comment.git
cd ai_comment
npm ci
npm start
```

[로컬 댓글 스튜디오](http://localhost:5000/)를 엽니다. Windows에서는 의존성을 설치한 뒤 `start.cmd`를 실행할 수 있습니다. 서버 환경변수 `GEMINI_API_KEY`로도 키를 설정할 수 있습니다. 소스 실행의 기본 기록 저장 위치는 `.studio-data`이며 `STUDIO_DATA_DIR`로 지정할 수 있습니다.

Windows x64 실행 파일을 다시 만들 때는 `powershell -File .\windows\build-windows.ps1`을 사용합니다.
</details>
