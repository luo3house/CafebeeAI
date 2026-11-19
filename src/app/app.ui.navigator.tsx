/**
 * Global navigation: Root Stack (Home=Drawer + the various manage/settings/list screens).
 * The navigators and the container ref are all app-level singletons, created via lazyInit on first use;
 * navigation can be driven globally from outside components (state/tool flow) through kNavigationRef.
 */
import React from "react"
import {
  NavigationContainer,
  createNavigationContainerRef,
  DrawerActions,
  type CompositeNavigationProp,
  type NavigatorScreenParams,
} from "@react-navigation/native"
import { createNativeStackNavigator, type NativeStackNavigationProp } from "@react-navigation/native-stack"
import { createDrawerNavigator, type DrawerNavigationProp } from "@react-navigation/drawer"
import { useTheme } from "react-native-paper"
import { lazyInit, type LazyValue } from "../core/lazy"
import { useNavigationTheme, type MD3Theme } from "./app.ui.theme"
import { ChatScreen } from "../ui/screens/chat/chat.screen"
import { ProjectManageScreen } from "../ui/screens/projects/project-manage.screen"
import { ProjectFilesScreen } from "../ui/screens/projects/project-files.screen"
import { StaticFsScreen } from "../ui/screens/projects/static-fs.screen"
import { FilePreviewScreen } from "../ui/screens/projects/file-preview.screen"
import { TextEditorScreen } from "../ui/screens/shared/text-editor.screen"
import type { TextEditorParams } from "../core/text-editor"
import { SettingsScreen } from "../ui/screens/settings/settings.screen"
import { ProvidersScreen } from "../ui/screens/settings/providers.screen"
import { ProviderFormScreen } from "../ui/screens/settings/provider-form.screen"
import { AboutScreen } from "../ui/screens/settings/about.screen"
import { ReasoningFullScreen } from "../ui/screens/chat/reasoning-full.screen"
import { AnswerFullScreen } from "../ui/screens/chat/answer-full.screen"
import { ToolDetailScreen, type ToolDetailParams } from "../ui/screens/chat/tool-detail.screen"
import { FormFullScreen } from "../ui/screens/chat/form-full.screen"
import { ConversationsScreen } from "../ui/screens/chat/conversations.screen"
import { ModelPickerScreen } from "../ui/screens/chat/model-picker.screen"
import { DebugScreen } from "../ui/screens/debug/debug.screen"
import { GitControlScreen } from "../ui/screens/git/git-control.screen"
import { GitRemoteScreen } from "../ui/screens/git/git-remote.screen"
import { GitCloneScreen } from "../ui/screens/git/git-clone.screen"
import { GitCredentialsScreen } from "../ui/screens/settings/git-credentials.screen"
import { GitOptionsScreen } from "../ui/screens/settings/git-options.screen"
import { GitTrustedHostsScreen } from "../ui/screens/settings/git-trusted-hosts.screen"
import { GitConfigScreen } from "../ui/screens/git/git-config.screen"
import { Sidebar } from "../ui/components/sidebar"
import { bindModelPickerNavigator } from "../state/modelpicker"

export type AppDrawerParamList = {
  ChatC: undefined
}

export type RootStackParamList = {
  Home: NavigatorScreenParams<AppDrawerParamList> | undefined
  ProjectManage: undefined
  ProjectFiles: undefined
  StaticFs: { projectId: string }
  FilePreview: { name: string; path: string }
  TextEditor: TextEditorParams
  SettingsHome: undefined
  Providers: undefined
  ProviderForm: { providerId?: string } | undefined
  About: undefined
  ReasoningFull: undefined
  AnswerFull: undefined
  ToolDetail: ToolDetailParams | undefined
  FormFull: { toolCallId: string }
  Conversations: undefined
  ModelPicker: undefined
  Debug: undefined
  GitControl: { projectId: string }
  GitRemote: { projectId: string }
  GitClone: { projectId: string }
  GitConfig: undefined
  GitCredentials: undefined
  GitOptions: undefined
  GitTrustedHosts: undefined
}

type ScreenNavigator = ReturnType<typeof createNativeStackNavigator<RootStackParamList>>
type DrawerNavigator = ReturnType<typeof createDrawerNavigator<AppDrawerParamList>>
type AppNavigationRef = ReturnType<typeof createNavigationContainerRef<RootStackParamList>>

/** Chat screen navigation: drawer screen + can navigate to the parent stack (ProjectManage/Settings etc.) */
export type AppNavigation = CompositeNavigationProp<
  DrawerNavigationProp<AppDrawerParamList, "ChatC">,
  NativeStackNavigationProp<RootStackParamList>
>

export const kScreenNavigator: LazyValue<ScreenNavigator> = lazyInit<ScreenNavigator>(
  () => createNativeStackNavigator<RootStackParamList>()
)

export const kDrawerNavigator: LazyValue<DrawerNavigator> = lazyInit<DrawerNavigator>(
  () => createDrawerNavigator<AppDrawerParamList>()
)

export const kNavigationRef: LazyValue<AppNavigationRef> = lazyInit<AppNavigationRef>(
  () => createNavigationContainerRef<RootStackParamList>()
)

bindModelPickerNavigator(() => {
  const ref = kNavigationRef()
  if (!ref.isReady()) return false
  if (ref.getCurrentRoute()?.name === "ModelPicker") return true
  ref.navigate("ModelPicker")
  return true
})

/** Safely open/close the home drawer from outside components (dispatched to the currently focused Drawer via the global container ref) */
export function openHomeDrawer() {
  const ref = kNavigationRef()
  if (ref.isReady()) ref.dispatch(DrawerActions.openDrawer())
}

export function closeHomeDrawer() {
  const ref = kNavigationRef()
  if (ref.isReady()) ref.dispatch(DrawerActions.closeDrawer())
}

function stackScreenOptions(theme: MD3Theme) {
  return {
    headerStyle: { backgroundColor: theme.colors.elevation.level3 },
    headerTintColor: theme.colors.onSurface,
    headerTitleStyle: { color: theme.colors.onSurface },
    contentStyle: { backgroundColor: theme.colors.background },
  } as const
}

function HomeDrawer() {
  const Drawer = kDrawerNavigator()
  const theme = useTheme<MD3Theme>()
  return (
    <Drawer.Navigator
      drawerContent={(props) => <Sidebar {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: "front",
        swipeEdgeWidth: 60,
        drawerStyle: { width: 300, backgroundColor: theme.colors.surface },
      }}
    >
      <Drawer.Screen name="ChatC" component={ChatScreen} />
    </Drawer.Navigator>
  )
}

export function RootNavigator() {
  const Stack = kScreenNavigator()
  const navigationTheme = useNavigationTheme()
  const theme = useTheme<MD3Theme>()
  return (
    <NavigationContainer ref={kNavigationRef()} theme={navigationTheme}>
      <Stack.Navigator screenOptions={stackScreenOptions(theme)}>
        <Stack.Screen name="Home" component={HomeDrawer} options={{ headerShown: false }} />
        <Stack.Screen name="ProjectManage" component={ProjectManageScreen} options={{ title: "Projects" }} />
        <Stack.Screen name="ProjectFiles" component={ProjectFilesScreen} options={{ title: "Project Files" }} />
        <Stack.Screen name="StaticFs" component={StaticFsScreen} options={{ title: "File Server" }} />
        <Stack.Screen name="FilePreview" component={FilePreviewScreen} options={{ title: "File Preview" }} />
        <Stack.Screen name="TextEditor" component={TextEditorScreen} options={{ title: "Edit" }} />
        <Stack.Screen name="SettingsHome" component={SettingsScreen} options={{ title: "Settings" }} />
        <Stack.Screen name="Providers" component={ProvidersScreen} options={{ title: "Providers" }} />
        <Stack.Screen name="ProviderForm" component={ProviderFormScreen} options={{ title: "Provider Setup" }} />
        <Stack.Screen name="About" component={AboutScreen} options={{ title: "About" }} />
        <Stack.Screen name="ReasoningFull" component={ReasoningFullScreen} options={{ headerShown: false }} />
        <Stack.Screen name="AnswerFull" component={AnswerFullScreen} options={{ headerShown: false }} />
        <Stack.Screen name="ToolDetail" component={ToolDetailScreen} options={{ headerShown: false }} />
        <Stack.Screen name="FormFull" component={FormFullScreen} options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="Conversations" component={ConversationsScreen} options={{ title: "Conversations" }} />
        <Stack.Screen name="ModelPicker" component={ModelPickerScreen} options={{ title: "Select Provider / Model" }} />
        <Stack.Screen name="Debug" component={DebugScreen} options={{ title: "Debug" }} />
        <Stack.Screen name="GitControl" component={GitControlScreen} options={{ title: "Git" }} />
        <Stack.Screen name="GitRemote" component={GitRemoteScreen} options={{ title: "Remote" }} />
        <Stack.Screen name="GitClone" component={GitCloneScreen} options={{ title: "Git Clone" }} />
        <Stack.Screen name="GitConfig" component={GitConfigScreen} options={{ title: "Global Git Config" }} />
        <Stack.Screen name="GitCredentials" component={GitCredentialsScreen} options={{ title: "Git Credentials" }} />
        <Stack.Screen name="GitOptions" component={GitOptionsScreen} options={{ title: "Git Options" }} />
        <Stack.Screen name="GitTrustedHosts" component={GitTrustedHostsScreen} options={{ title: "Trusted Hosts" }} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
