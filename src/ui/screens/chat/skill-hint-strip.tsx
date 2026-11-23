/**
 * Skill candidate strip (rule 36): while an in-progress slash token is being typed at the end of the draft
 * ("/" alone lists every skill, further keys narrow case-insensitively by prefix), display it as a height-capped
 * single line of outline pills between the message list and the input area; the height collapses to 0 when there
 * is no token. Purely informational - the pills carry no action (tag buttons built without onPress).
 * This tiny FC is the only shell component allowed to subscribe to draftStore (sync:true): ChatScreen stays off
 * the keystroke path; detection is debounced (~150ms) so a fast typing burst only renders the stable result.
 */
import React, { useEffect, useState } from "react"
import { ScrollView, StyleSheet, View } from "react-native"
import { useSnapshot } from "valtio"
import { draftStore } from "../../../state/chat"
import { TagButton } from "../../components/tag-button"
import { kSkillStore, trailingSlashInput } from "../../../core/skills"

export function SkillHintStrip({ draftKey }: { draftKey: string }) {
  const snap = useSnapshot(draftStore, { sync: true })
  const value = snap[draftKey] ?? ""
  const [names, setNames] = useState<string[]>([])

  useEffect(() => {
    const timer = setTimeout(() => {
      const token = trailingSlashInput(value)
      setNames(token === null ? [] : kSkillStore().candidateNames(token.toLowerCase()))
    }, 150)
    return () => clearTimeout(timer)
  }, [value])

  if (names.length === 0) return null

  return (
    <View pointerEvents="none" style={styles.wrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {names.map((name) => (
          <TagButton key={name} label={`/${name}`} tone="neutral" />
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 2 },
  row: { gap: 6, paddingVertical: 2 },
})
