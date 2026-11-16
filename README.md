# 운명원 댓글 스튜디오

YouTube 링크로 공개 영상과 댓글을 읽고, 선택한 원댓글에 맞는 AI 답글과 게시 결과를 관리하는 로컬 앱입니다.

## 실행

Node.js 24 이상과 Chrome을 설치한 환경에서 저장소를 내려받고 실행하세요. 영상과 댓글 조회에는 Chrome의 임시 세션을 사용합니다.

```sh
git clone https://github.com/tarobo22/ai_comment.git
cd ai_comment
npm ci
npm start
```

[로컬 댓글 스튜디오](http://localhost:5000/)를 엽니다. Windows에서는 의존성 설치 후 `start.cmd`로도 실행할 수 있습니다.

3번 AI 생성은 Gemini 3.1 Flash-Lite를 사용합니다. 서버 환경변수 `GEMINI_API_KEY` 또는 현재 Windows 계정의 로컬 암호화 파일에서 키를 읽습니다. 무료로 사용하려면 키가 연결된 AI Studio 프로젝트를 **무료 등급**으로 유지하세요. 사용량 한도에 걸리면 앱에 안내가 표시됩니다. [Gemini 요금표](https://ai.google.dev/gemini-api/docs/pricing/#gemini-3.1-flash-lite)

Windows에서 저장한 Gemini 키를 교체할 때는 PowerShell에서 아래 명령을 실행한 뒤 앱을 다시 시작합니다.

```powershell
$studioKeyDir = Join-Path $env:LOCALAPPDATA 'UnmyeongwonStudio'
$studioKey = Read-Host 'Gemini API key' -AsSecureString
[void][IO.Directory]::CreateDirectory($studioKeyDir)
ConvertFrom-SecureString -SecureString $studioKey |
    Set-Content -LiteralPath (Join-Path $studioKeyDir 'gemini-api-key.dpapi') -Encoding Ascii -NoNewline
$studioKey.Dispose()
```

제작을 요청하면 선택한 원댓글 본문, 영상 정보와 분석 근거, 작성 설정, 운명원 포지션과 프롬프트가 모델에 전달됩니다. 운명원 포지션은 현재 브라우저에 저장되며 AI 제작을 요청할 때 사용됩니다.

## 사용

1. **영상 선택**에서 최근 연애 영상 목록을 불러오거나 YouTube 링크를 붙여넣습니다. **영상 분석**을 실행하면 자막 근거와 시간대가 표시됩니다. 자막을 읽을 수 없으면 제목·설명을 사용합니다. 운명원 포지션은 이 단계에서 입력합니다.
2. **댓글 대상**에 들어가 공개 댓글을 불러온 뒤 답글을 만들 원댓글을 고릅니다.
3. **AI로 글 작성하기**에서 공통 말투, 답변 방향, 읽는 대상을 선택해 제작합니다. 두 버전 모두 **영상 · 공감 · 운명원 연결** 순서로 표시합니다. 분위기가 밝은 댓글의 표현을 살린 버전에는 `ㅋㅋ`나 `ㅎㅎ`가 들어갈 수 있습니다. 원하는 버전을 선택해 문구를 수정하거나 설정을 바꿔 재생성합니다.
4. **실행하기**에서 확정한 답글을 게시하고 기록을 확인합니다. 기존 YouTube 로그인으로 한 글자씩 입력하려면 게시에 사용할 Chrome 프로필의 `chrome://extensions`에서 개발자 모드를 켠 뒤 **압축해제된 확장 프로그램을 로드합니다**를 눌러 앱 폴더의 `chrome-extension`을 선택하세요. 같은 프로필에서 스튜디오를 새로고침하고 4번의 **Chrome에서 게시** 항목을 사용합니다. 직접 게시한 답글도 **게시 확인**을 통해 기록할 수 있습니다.

게시 준비에는 운명원 언급, 40~120자, 링크·해시태그 금지 규칙을 적용합니다. 영상당 1개, 한국 시간 기준 하루 10개를 이 앱에서 공통 적용합니다. 공개 화면에서 답글을 확인하기 어려운 작업은 확인 보류에 남고 기록 화면에서 다시 확인할 수 있습니다.

새로 내려받은 앱의 기록은 `.studio-data`에 로컬로 보관됩니다. 원래 작업 폴더에 `work/unmyeongwon-studio-data`가 이미 있으면 그 기록을 계속 사용합니다. 저장 위치는 `STUDIO_DATA_DIR`로 지정할 수 있습니다.
