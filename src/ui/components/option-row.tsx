/**
 * Full-row pressable radio / checkbox lines (rule 1 + rule 2: the AppPressable row is the sole responder and
 * the Paper control rides along as a presentational dot - `pointerEvents:"none"` - so "only the checker
 * responds" can never happen again; tapping anywhere on the row toggles it).
 */
import React from "react"
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native"
import { Checkbox, RadioButton, Text, useTheme } from "react-native-paper"
import { fs } from "../../app/app.ui.theme"
import { AppPressable } from "./app-pressable"

interface OptionRowProps {
  checked: boolean
  onPress: () => void
  disabled?: boolean
  title: string
  description?: string
  titleStyle?: StyleProp<TextStyle>
  style?: StyleProp<ViewStyle>
}

const OptionRow: React.FC<OptionRowProps & { control: React.ReactNode }> = ({
  onPress,
  disabled,
  title,
  description,
  titleStyle,
  style,
  control,
}) => {
  const theme = useTheme()
  return (
    <AppPressable style={style} disabled={disabled} onPress={onPress}>
      <View style={styles.row}>
        <View pointerEvents="none" style={styles.control}>
          {control}
        </View>
        <View style={styles.labelBlock}>
          <Text numberOfLines={2} style={[{ color: theme.colors.onSurface, fontSize: fs(theme, 13) }, titleStyle]}>
            {title}
          </Text>
          {description ? (
            <Text numberOfLines={2} style={{ color: theme.colors.onSurfaceVariant, fontSize: fs(theme, 12) }}>
              {description}
            </Text>
          ) : null}
        </View>
      </View>
    </AppPressable>
  )
}

export function RadioRow({ value, ...props }: OptionRowProps & { value: string }): React.ReactElement {
  return (
    <OptionRow
      {...props}
      control={<RadioButton value={value} status={props.checked ? "checked" : "unchecked"} disabled={props.disabled} />}
    />
  )
}

export function CheckRow(props: OptionRowProps): React.ReactElement {
  return <OptionRow {...props} control={<Checkbox status={props.checked ? "checked" : "unchecked"} disabled={props.disabled} />} />
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 3 },
  control: { marginRight: 2 },
  labelBlock: { flex: 1, gap: 1 },
})
