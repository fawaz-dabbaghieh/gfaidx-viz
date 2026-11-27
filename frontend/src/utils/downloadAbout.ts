// The "key: value" lines at the top of every table download: where the graph
// came from (the gfaidx graph, region and method, or the file) and when it
// was downloaded, so the file still says what it describes away from the app.
export function aboutLines(origin: string[]): string[] {
  return [...origin, `downloaded: ${new Date().toISOString().slice(0, 10)}`]
}

// As '#' comment lines, under a TSV's title line.
export function commentLines(about: string[]): string[] {
  return about.map(line => `# ${line}`)
}
