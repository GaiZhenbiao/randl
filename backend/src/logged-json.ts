// Python's JSON encoder permits these non-finite numeric tokens. Preserve text
// strings, but store numeric non-finite values as null so exports stay valid JSON.
export function parseLoggedJSON(text: string): any {
  return JSON.parse(
    text.replace(/"(?:\\.|[^"\\])*"|\bNaN\b|-?\bInfinity\b/g, (token) =>
      token.startsWith('"') ? token : 'null',
    ),
  );
}
