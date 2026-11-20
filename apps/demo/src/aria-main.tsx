import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { webSocketDial } from "figaro-forms";
import { AriaClient } from "figaro-forms/aria";
import { AriaProvider } from "figaro-forms/aria/react";
import { doorUrl, edgeSession } from "figaro-forms/auth";
import { AriaPage } from "./AriaPage.js";

function door(): URL {
  const hash = new URLSearchParams(location.hash.slice(1));
  const url = new URL(hash.get("door") ?? doorUrl("/door").href);
  const token = hash.get("token");
  if (token) url.searchParams.set("token", token);
  return url;
}

const url = door();
const client = new AriaClient({ dial: webSocketDial({ url, credential: edgeSession() }) });
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AriaProvider client={client}>
        <AriaPage door={url.origin + url.pathname} />
      </AriaProvider>
    </StrictMode>,
  );
}
