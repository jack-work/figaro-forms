import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FormsClient, webSocketDial } from "figaro-forms";
import { doorUrl, edgeSession } from "figaro-forms/auth";
import { FormsProvider } from "figaro-forms/react";
import { App } from "./App.js";

function door(): URL {
  const hash = new URLSearchParams(location.hash.slice(1));
  const url = new URL(hash.get("door") ?? doorUrl("/door").href);
  const token = hash.get("token");
  if (token) url.searchParams.set("token", token);
  return url;
}

const url = door();
const client = new FormsClient({ dial: webSocketDial({ url, credential: edgeSession() }) });
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <FormsProvider client={client}>
        <App door={url.origin + url.pathname} />
      </FormsProvider>
    </StrictMode>,
  );
}
