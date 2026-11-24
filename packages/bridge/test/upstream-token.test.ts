import { describe, expect, it } from "vitest";
import { upstreamTokenPath } from "../src/token.js";

const none = (): boolean => false;
const all = (): boolean => true;

describe("upstreamTokenPath", () => {
  it("reads no upstream credential in token mode even when systemd sets CREDENTIALS_DIRECTORY", () => {
    expect(upstreamTokenPath({ credentialsDirectory: "/run/credentials/g", tokenMode: true, exists: all })).toBeUndefined();
  });
  it("refuses an explicit upstream token file in token mode", () => {
    expect(() => upstreamTokenPath({ flag: "/x", tokenMode: true, exists: all })).toThrow(/alternatives/);
  });
  it("uses the flag in static mode", () => {
    expect(upstreamTokenPath({ flag: "/x", credentialsDirectory: "/c", tokenMode: false, exists: none })).toBe("/x");
  });
  it("uses a LoadCredential named upstream-token only when it exists", () => {
    expect(upstreamTokenPath({ credentialsDirectory: "/c", tokenMode: false, exists: all })).toBe("/c/upstream-token");
    expect(upstreamTokenPath({ credentialsDirectory: "/c", tokenMode: false, exists: none })).toBeUndefined();
  });
  it("has no upstream credential with neither flag nor directory", () => {
    expect(upstreamTokenPath({ tokenMode: false, exists: all })).toBeUndefined();
  });
});
