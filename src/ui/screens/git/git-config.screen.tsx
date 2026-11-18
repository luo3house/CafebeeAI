/**
 * Global Git Config hub (Settings > Global Git Config): the single entry point for the three global git
 * management pages - credentials, client options (commit author / TLS / host-key policy), trusted SSH hosts.
 */
import React from "react"
import { ScrollView, StyleSheet } from "react-native"
import { Divider, List } from "react-native-paper"
import { useSafeAreaInsets } from "react-native-safe-area-context"

export function GitConfigScreen({ navigation }: { navigation: any }) {
  const insets = useSafeAreaInsets()

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: insets.bottom }}>
      <List.Section>
        <List.Item
          style={styles.listItem}
          title="Git Credentials"
          description="SSH key pairs and username + password entries for remote repositories"
          left={(p) => <List.Icon {...p} icon="key-variant" />}
          onPress={() => navigation.navigate("GitCredentials")}
        />
        <Divider />
        <List.Item
          style={styles.listItem}
          title="Git Options"
          description="Commit author, TLS verification, and SSH host-key policy"
          left={(p) => <List.Icon {...p} icon="source-branch" />}
          onPress={() => navigation.navigate("GitOptions")}
        />
        <Divider />
        <List.Item
          style={styles.listItem}
          title="Manage Trusted Hosts"
          description="SSH hosts remembered by trust-on-first-use"
          left={(p) => <List.Icon {...p} icon="shield-lock-outline" />}
          onPress={() => navigation.navigate("GitTrustedHosts")}
        />
      </List.Section>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listItem: { minHeight: 44, paddingVertical: 2 },
})
