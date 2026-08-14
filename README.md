# MOM Generator — Sarvam AI + Claude

Upload a meeting audio/video → get structured Minutes of Meeting.

## Setup (one time)

```bash
# 1. Install Node.js from nodejs.org if not installed

# 2. Install dependencies
npm install

# 3. Add your API keys to .env
#    SARVAM_API_KEY is already filled in
#    Add your Anthropic key:
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

## Run

```bash
npm start
```

Then open: **http://localhost:3000**

## Usage

1. Open http://localhost:3000 in your browser
2. Upload your audio/video file (MP3, MP4, WAV, M4A etc.)
3. Select the meeting language
4. Enter your Anthropic API key (or add to .env to avoid typing each time)
5. Click **Generate MOM**
6. Your structured MOM appears — copy or download

## File size limit
- Current limit: 50 MB
- Sarvam processes up to ~30 min per file
- For longer recordings, split the audio first

## API Keys
- **Sarvam AI**: Already in .env — get new keys at console.sarvam.ai
- **Anthropic**: console.anthropic.com → API Keys → Create key
"# MOM" 
