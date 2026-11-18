/**
 * App entry point (github flavor). Registers the component.
 * (The polyfills formerly required by the AI SDK were removed along with the hand-written LLM client: XHR yields decoded responseText directly, no stream/codec fallbacks needed.)
 */
import { AppRegistry } from "react-native"
import { App } from "../app/app.ui"

AppRegistry.registerComponent("CafebeeAI", () => App)
