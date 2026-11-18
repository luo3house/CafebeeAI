/**
 * Centralized Pressable event layer: styles always live on the outer View, Pressable only handles events.
 */
import React, { useRef, useState } from "react"
import { Pressable, View, type ViewStyle, type StyleProp, type PressableProps } from "react-native"

export interface AppPressableProps extends Omit<PressableProps, "style" | "children"> {
  style?: StyleProp<ViewStyle>
  pressedStyle?: StyleProp<ViewStyle>
  disabledStyle?: StyleProp<ViewStyle>
  hoverOpacity?: number
  children: React.ReactNode
}

export function AppPressable({
  style,
  pressedStyle,
  disabledStyle,
  hoverOpacity,
  onPress,
  onLongPress,
  disabled,
  children,
  ...rest
}: AppPressableProps) {
  const [pressed, setPressed] = useState(false)
  const innerRef = useRef<View>(null)

  const handlePressIn = (e: any) => {
    setPressed(true)
    rest.onPressIn?.(e)
  }
  const handlePressOut = (e: any) => {
    setPressed(false)
    rest.onPressOut?.(e)
  }

  const dimmed = hoverOpacity ?? 0.85

  return (
    <View
      style={[
        style,
        pressed ? [pressedStyle ?? { opacity: dimmed }] : null,
        disabled ? disabledStyle ?? { opacity: 0.5 } : null,
      ]}
    >
      <Pressable
        ref={innerRef}
        onPress={disabled ? undefined : onPress}
        onLongPress={disabled ? undefined : onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled}
      >
        {children}
      </Pressable>
    </View>
  )
}