import { describe, expect, it } from "vitest";
import { doorTokenPath } from "../src/token.js";

const none = (): boolean => false;
const all = (): boolean => true;

describe("doorTokenPath", () => {
  it("reads no door credential in token mode even when systemd sets CREDENTIALS_DIRECTORY", () => {
    expect(doorTokenPath({ credentialsDirectory: "/run/credentials/g", tokenMode: true, exists: all })).toBeUndefined();
  });
  it("refuses an explicit door token file in token mode", () => {
    expect(() => doorTokenPath({ flag: "/x", tokenMode: true, exists: all })).toThrow(/alternatives/);
  });
  it("uses the flag in static mode", () => {
    expect(doorTokenPath({ flag: "/x", credentialsDirectory: "/c", tokenMode: false, exists: none })).toBe("/x");
  });
  it("uses a LoadCredential named door only when it exists", () => {
    expect(doorTokenPath({ credentialsDirectory: "/c", tokenMode: false, exists: all })).toBe("/c/door");
    expect(doorTokenPath({ credentialsDirectory: "/c", tokenMode: false, exists: none })).toBeUndefined();
  });
  it("has no door credential with neither flag nor directory", () => {
    expect(doorTokenPath({ tokenMode: false, exists: all })).toBeUndefined();
  });
});
