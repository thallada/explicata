import "@fontsource-variable/source-serif-4/opsz.css";
import "@fontsource-variable/source-serif-4/opsz-italic.css";
import "@fontsource-variable/source-sans-3/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./style.css";
import { render } from "preact";
import { App } from "./App";
import { store } from "./store";

render(<App />, document.getElementById("app")!);
void store.boot();
