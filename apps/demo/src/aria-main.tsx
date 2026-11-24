import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { webSocketDial } from "figaro-forms";
import { AriaClient } from "figaro-forms/aria";
import { AriaProvider } from "figaro-forms/aria/react";
import { endpointUrl, edgeSession } from "figaro-forms/auth";
import { AriaPage } from "./AriaPage.js";

function endpoint(): URL {
  const hash = new URLSearchParams(location.hash.slice(1));
  const url = new URL(hash.get("endpoint") ?? endpointUrl("/rpc").href);
  const token = hash.get("token");
  if (token) url.searchParams.set("token", token);
  return url;
}

const url = endpoint();
const client = new AriaClient({ dial: webSocketDial({ url, credential: edgeSession() }) });
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <AriaProvider client={client}>
        <AriaPage endpoint={url.origin + url.pathname} />
      </AriaProvider>
    </StrictMode>,
  );
}
