// @ts-nocheck
/* eslint-disable */

/**
 * node main.js
 *
 * ENV:
 *   OPENAI_BASE_URL=https://your-server/v1
 *   OPENAI_API_KEY=sk-xxxxx
 *   OPENAI_MODEL=gpt-4o-mini
 */

const BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1"
const API_KEY = "12345"
const MODEL = "mimo-v2.6-flash"

async function main() {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant.",
        },
        {
          role: "user",
          content: "Explain PostgreSQL VACUUM in one paragraph.",
        },
      ],
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`HTTP ${response.status}\n${errText}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    buffer += decoder.decode(value, {
      stream: true,
    })

    const lines = buffer.split("\n")

    buffer = lines.pop() || ""

    for (const line of lines) {
      const trimmed = line.trim()

      if (!trimmed.startsWith("data:")) {
        continue
      }

      const data = trimmed.substring(5).trim()

      if (data === "[DONE]") {
        console.log("\n\n[STREAM ENDED]")
        return
      }

      try {
        const json = JSON.parse(data)

        const content = json.choices?.[0]?.delta?.content

        if (content) {
          process.stdout.write(content)
        }
      } catch (err) {
        console.error("\nFailed to parse chunk:", data)
      }
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
