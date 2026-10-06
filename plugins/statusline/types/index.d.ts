export type ModelState = { selected: string | null; selectedAt: number; answered: string | null; requested: string | null; effort: string | null; answeredRequestedAt: number }
export type GitInfo = { head: string; isDetached: boolean; isDirty: boolean; ahead: number; behind: number }
export type WorkspaceState = { cwd: string | null; home: string | null; git: GitInfo | null }

declare module 'claude-code' {
  interface PluginState {
    'statusline': {
      model: ModelState
      workspace: WorkspaceState
    }
  }
}
