/**
 * Sidebar (Drawer content): project switching + Projects + Settings entry (conversation switching is centralized in the chat page header).
 */
import React, { useEffect } from "react"
import { ScrollView, StyleSheet, Text, View } from "react-native"
import { Drawer, Divider, Icon, IconButton, useTheme } from "react-native-paper"
import Config from "react-native-config"
import { APP_NAME } from "../../app/app.constants"
import { fs, type MD3Theme } from "../../app/app.ui.theme"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useSnapshot } from "valtio"
import type { DrawerContentComponentProps } from "@react-navigation/drawer"
import { runtime } from "../../state/runtime"
import { staticFs } from "../../state/staticfs"
import { AppPressable } from "./app-pressable"
import { kChatStore } from "../../core/chats"
import { listProjects } from "../../core/projects"
import { bindConversation } from "../../state/chat"

export function Sidebar(props: DrawerContentComponentProps) {
  const { navigation } = props
  const theme = useTheme<MD3Theme>()
  const snap = useSnapshot(runtime)
  const fsSnap = useSnapshot(staticFs)
  const insets = useSafeAreaInsets()

  useEffect(() => {
    const refreshAll = async () => {
      const projects = await listProjects()
      runtime.projects = projects
      if (runtime.currentProjectId) {
        const briefs = await kChatStore().list(runtime.currentProjectId)
        runtime.conversations = briefs.map((b) => b.conversation)
      }
    }
    void refreshAll()
  }, [snap.currentProjectId])

  const switchProject = async (id: string) => {
    if (id === snap.currentProjectId) {
      navigation.closeDrawer()
      return
    }
    runtime.currentProjectId = id
    runtime.currentConversationId = null
    const briefs = await kChatStore().list(id)
    runtime.conversations = briefs.map((b) => b.conversation)
    if (briefs.length) {
      // Auto-binding landing conversation on project switch: does not mark read (the landing badge must not be swallowed, R8 decision)
      await bindConversation(id, briefs[0].conversation.id, { markRead: false })
    }
    navigation.navigate("ChatC")
    navigation.closeDrawer()
  }

  return (
    <ScrollView style={{ flex: 1, paddingTop: insets.top, paddingBottom: insets.bottom }} contentContainerStyle={{ paddingHorizontal: 8 }}>
      <View style={styles.brandRow}>
        <Text style={[styles.brand, { color: theme.colors.onSurface, fontSize: fs(theme, 18) }]}>{Config.APP_NAME || APP_NAME}</Text>
        <IconButton icon="folder-plus-outline" size={20} onPress={() => navigation.navigate("ProjectManage")} />
        <IconButton icon="cog-outline" size={20} onPress={() => navigation.navigate("SettingsHome")} />
      </View>

      <Drawer.Section showDivider={false} title="Projects">
        {snap.projects.map((project) => {
          const serving = fsSnap.status === "running" && fsSnap.projectId === project.id
          return (
            <Drawer.Item
              key={project.id}
              label={project.displayName}
              icon="folder-outline"
              active={project.id === snap.currentProjectId}
              onPress={() => switchProject(project.id)}
              right={
                serving
                  ? () => (
                      <AppPressable
                        style={styles.servingWrap}
                        pressedStyle={styles.servingPressed}
                        onPress={() => {
                          navigation.navigate("StaticFs", { projectId: project.id })
                          navigation.closeDrawer()
                        }}
                      >
                        <Icon source="wifi" size={20} color={theme.colors.tertiary} />
                      </AppPressable>
                    )
                  : undefined
              }
            />
          )
        })}
      </Drawer.Section>

      <Divider style={{ marginVertical: 6 }} />

      <Drawer.Item label="Projects" icon="folder-cog-outline" onPress={() => navigation.navigate("ProjectManage")} />
      <Drawer.Item label="Settings" icon="cog-outline" onPress={() => navigation.navigate("SettingsHome")} />
      <Drawer.Item label="About" icon="information-outline" onPress={() => navigation.navigate("About")} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  brand: { flex: 1, fontWeight: "800", fontSize: 18, paddingLeft: 16 },
  servingWrap: { paddingHorizontal: 12, justifyContent: "center", alignSelf: "center" },
  servingPressed: { opacity: 0.6 },
})
