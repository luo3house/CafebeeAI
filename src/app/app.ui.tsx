/**
 * Root App component: GestureHandler + SafeArea + Paper Provider (theme-aware) + navigation + global hosts.
 */
import React from "react"
import { StatusBar } from "react-native"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { PaperProvider } from "react-native-paper"
import { useActiveTheme } from "./app.ui.theme"
import { RootNavigator } from "./app.ui.navigator"
import { GlobalHosts } from "../ui/host/global-hosts"

export function App() {
  const theme = useActiveTheme()
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle={theme.dark ? "light-content" : "dark-content"} backgroundColor={theme.colors.background} />
        <PaperProvider theme={theme}>
          <RootNavigator />
          <GlobalHosts />
        </PaperProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
