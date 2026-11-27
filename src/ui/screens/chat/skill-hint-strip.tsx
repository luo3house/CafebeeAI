/**
 * Skill candidate strip (rule 36): while an in-progress slash token is being typed at the end of the draft
 * ("/" alone lists every skill, further keys narrow case-insensitively by prefix), display it as a height-capped
 * single line of outline pills between the message list and the input area; the height collapses to 0 when there
 * is no token. A pill tap completes the typed token to the canonical `/<stored name> ` via the onComplete callback
 * (the trailing space is the rule-36 submit-marker; the body is NEVER pasted into the draft - expansion happens at
 * send time only). This tiny FC is the only shell component allowed to subscribe to draftStore (sync:true):
 * ChatScreen stays off the keystroke path; detection is debounced (~150ms) so a fast typing burst only renders the
 * stable result.
 */
import React, { useEffect, useState } from "react"
import { ScrollView, StyleSheet, View } from "react-native"
import { useSnapshot } from "valtio"
import { draftStore } from "../../../state/chat"
import { TagButton } from "../../components/tag-button"
import { kSkillStore, trailingSlashInput } from "../../../core/skills"

export function SkillHintStrip({ draftKey, onComplete }: { draftKey: string; onComplete: (name: string) => void }) {
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
    <View style={styles.wrap}>
      {/* keyboardShouldPersistTaps: a pill tap must register while the input keeps the keyboard open (default
          "never" would swallow the tap into a keyboard dismiss) */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.row}>
        {names.map((name) => (
          <TagButton key={name} label={`/${name}`} tone="neutral" onPress={() => onComplete(name)} />
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 2 },
  row: { gap: 6, paddingVertical: 2 },
})
