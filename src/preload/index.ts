import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  MetadataArtwork,
  SongMetadataSearchRequest,
  SongMetadataSearchResult
} from '../shared/songMetadata'

// Custom APIs for renderer
const api = {
  // Dialog APIs
  openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),

  importSongPackage: (): Promise<string | null> => ipcRenderer.invoke('dialog:importSongPackage'),

  // Folder APIs
  scanFolder: (
    folderPath: string
  ): Promise<Array<{ id: string; path: string; name: string; addedAt: number }>> =>
    ipcRenderer.invoke('folder:scan', folderPath),

  // Dialog APIs
  openAudioDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openAudio'),

  openAudioFilesDialog: (): Promise<string[]> => ipcRenderer.invoke('dialog:openAudioFiles'),

  openAudioFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openAudioFolder'),

  openOutputFolderDialog: (): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openOutputFolder'),

  showItemInFolder: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:showItemInFolder', filePath),

  getDefaultAutoChartOutputDir: (): Promise<string> =>
    ipcRenderer.invoke('strum:getDefaultOutputFolder'),

  chooseDatasetPackageFolder: (): Promise<{
    groupId: string
    groupName: string
    strumGeneratedCount: number
    candidates: Array<{
      candidateId: string
      groupId: string
      kind: 'octave-library' | 'sng' | 'rb3con' | 'zip'
      songCount: number
      metadata: Record<string, string>
      midiValid: boolean
      instruments: Record<
        string,
        { status: 'present' | 'absent'; difficulties: string[]; trackNames: string[] }
      >
      trainingUse: 'allowed' | 'review_required'
      warnings: Array<{ code: string }>
      isStrumGenerated: boolean
    }>
  } | null> => ipcRenderer.invoke('dataset:choosePackageFolder'),

  removeDatasetPackageGroup: (candidateIds: string[]): Promise<void> =>
    ipcRenderer.invoke('dataset:removePackageGroup', candidateIds),

  onDatasetScanProgress: (
    callback: (progress: {
      phase: 'discovering' | 'inspecting'
      completed: number
      total: number
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: { phase: 'discovering' | 'inspecting'; completed: number; total: number }
    ): void => callback(progress)
    ipcRenderer.on('dataset:scanProgress', listener)
    return () => ipcRenderer.removeListener('dataset:scanProgress', listener)
  },

  onDatasetSaveProgress: (
    callback: (progress: {
      phase: 'checking' | 'normalizing' | 'materializing' | 'validating'
      completed: number
      total: number
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: {
        phase: 'checking' | 'normalizing' | 'materializing' | 'validating'
        completed: number
        total: number
      }
    ): void => callback(progress)
    ipcRenderer.on('dataset:saveProgress', listener)
    return () => ipcRenderer.removeListener('dataset:saveProgress', listener)
  },

  chooseDatasetCatalogParent: (): Promise<{
    parentId: string
    name: string
    path: string
  } | null> => ipcRenderer.invoke('dataset:chooseCatalogParent'),

  useDefaultDatasetCatalogParent: (): Promise<{
    parentId: string
    name: string
    path: string
  } | null> => ipcRenderer.invoke('dataset:useDefaultCatalogParent'),

  restoreDatasetCatalogParent: (
    parentId: string
  ): Promise<{ parentId: string; name: string; path: string } | null> =>
    ipcRenderer.invoke('dataset:restoreCatalogParent', parentId),

  listDatasetCatalogs: (
    parentId: string
  ): Promise<
    Array<{
      catalogName: string
      catalogId: string
      provenance: string
      license: string
      recordCount: number
      libraryRecordCount: number
      externalRecordCount: number
    }>
  > => ipcRenderer.invoke('dataset:listCatalogs', parentId),

  scanDatasetLibrary: (): Promise<
    Array<{
      candidateId: string
      kind: 'octave-library' | 'sng' | 'rb3con' | 'zip'
      songCount: number
      metadata: Record<string, string>
      midiValid: boolean
      instruments: Record<
        string,
        { status: 'present' | 'absent'; difficulties: string[]; trackNames: string[] }
      >
      trainingUse: 'allowed' | 'review_required'
      warnings: Array<{ code: string }>
      isStrumGenerated: boolean
    }>
  > => ipcRenderer.invoke('dataset:scanLibrary'),

  setDatasetSongOptIn: (candidateId: string, optedIn: boolean): Promise<boolean> =>
    ipcRenderer.invoke('dataset:setSongOptIn', candidateId, optedIn),

  setDatasetPackageApproved: (candidateId: string, approved: boolean): Promise<boolean> =>
    ipcRenderer.invoke('dataset:setPackageApproved', candidateId, approved),

  readDatasetCandidateArtwork: (candidateId: string): Promise<string | null> =>
    ipcRenderer.invoke('dataset:readCandidateArtwork', candidateId),

  buildSongSourceCatalog: (options: {
    candidateIds: string[]
    parentId: string
    catalogName: string
    catalogId: string
    provenance: string
    license: string
    mode: 'create' | 'update' | 'clone'
    sourceCatalogName?: string
  }): Promise<{
    recordCount: number
    skipped: Array<{ reason: string }>
  }> => ipcRenderer.invoke('dataset:export', options),

  getTrainingRuntime: (): Promise<{
    runtimeId: string
    displayName: string
    kind: 'bundled_inference' | 'developer_override' | 'managed_checkout' | 'installed_runtime'
    protocolVersion: string
    capabilities: string[]
    pipelineIds: string[]
    deviceSupport: string[]
    trainingSetupRequired: boolean
    dirty: boolean
    sourceRevision: string | null
  } | null> => ipcRenderer.invoke('training:runtime'),

  enableDeveloperTrainingRuntime: (): Promise<{
    runtimeId: string
    displayName: string
    kind: 'bundled_inference' | 'developer_override' | 'managed_checkout' | 'installed_runtime'
    protocolVersion: string
    capabilities: string[]
    pipelineIds: string[]
    deviceSupport: string[]
    trainingSetupRequired: boolean
    dirty: boolean
    sourceRevision: string | null
  } | null> => ipcRenderer.invoke('training:enableDeveloperRuntime'),

  chooseInstalledTrainingRuntime: (): Promise<{
    runtimeId: string
    displayName: string
    kind: 'bundled_inference' | 'developer_override' | 'managed_checkout' | 'installed_runtime'
    protocolVersion: string
    capabilities: string[]
    pipelineIds: string[]
    deviceSupport: string[]
    trainingSetupRequired: boolean
    dirty: boolean
    sourceRevision: string | null
  } | null> => ipcRenderer.invoke('training:chooseInstalledRuntime'),

  listTrainingPipelines: (): Promise<
    Array<{
      id: string
      display_name: string
      kind: string
      catalog_requirements: {
        instrument: string
        difficulties: string[]
        audio_roles: string[]
        audio_policy: string
      }
      prepare_schema: Record<string, unknown>
      train_schema: Record<string, unknown>
      checkpoint_outputs: string[]
      inference_capability: string | null
    }>
  > => ipcRenderer.invoke('training:pipelines'),

  listTrainingArtifacts: (): Promise<{
    tasks: Array<{
      taskViewId: string
      catalogId: string
      catalogName: string
      pipelineId: string
      eligibleCount: number
      contentHash: string
      createdAt: string
    }>
    runs: Array<{
      runId: string
      taskViewId: string
      pipelineId: string
      checkpointCount: number
      deployable: boolean
      checkpointManifestHash: string
      createdAt: string
    }>
    profiles: Array<{
      profileId: string
      runId: string
      pipelineId: string
      runtimeId: string
      createdAt: string
      isDefault: boolean
    }>
  }> => ipcRenderer.invoke('training:artifacts'),

  inspectTrainingCheckpoint: (
    runId: string
  ): Promise<{
    runId: string
    pipelineId: string
    runtimeId: string
    taskViewId: string
    taskViewHash: string
    checkpointManifestHash: string
    deployable: boolean
    deploymentReason: string | null
    components: Array<{ id: string; sha256: string; byteLength: number }>
  }> => ipcRenderer.invoke('training:inspectCheckpoint', runId),

  saveAutoChartProfile: (
    runId: string
  ): Promise<{
    profileId: string
    runId: string
    pipelineId: string
    runtimeId: string
    createdAt: string
    isDefault: boolean
  }> => ipcRenderer.invoke('training:saveAutoChartProfile', runId),

  inspectTrainingCatalog: (options: {
    parentId: string
    catalogName: string
    pipelineId: string
  }): Promise<{
    pipelineId: string
    eligibleCount: number
    recordCount: number
    excluded: Record<string, number>
    audioPolicy: string
    estimatedStorageBytes: number
  }> => ipcRenderer.invoke('training:inspectCatalog', options),

  prepareTrainingDataset: (options: {
    parentId: string
    catalogId: string
    catalogName: string
    pipelineId: string
    prepare: Record<string, unknown>
  }): Promise<{ jobId: string; taskViewId: string }> =>
    ipcRenderer.invoke('training:prepare', options),

  startTrainingRun: (options: {
    taskViewId: string
    pipelineId: string
    train: Record<string, unknown>
  }): Promise<{ jobId: string; runId: string }> => ipcRenderer.invoke('training:start', options),

  cancelTrainingJob: (jobId: string): Promise<boolean> =>
    ipcRenderer.invoke('training:cancel', jobId),

  onTrainingProgress: (
    callback: (event: {
      jobId: string
      sequence: number
      stage: string
      progress?: number
      state?:
        | 'queued'
        | 'validating'
        | 'provisioning'
        | 'running'
        | 'cancelling'
        | 'succeeded'
        | 'failed'
        | 'cancelled'
      code?: string
      message: string
      result?: Record<string, unknown>
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: {
        jobId: string
        sequence: number
        stage: string
        progress?: number
        state?:
          | 'queued'
          | 'validating'
          | 'provisioning'
          | 'running'
          | 'cancelling'
          | 'succeeded'
          | 'failed'
          | 'cancelled'
        code?: string
        message: string
        result?: Record<string, unknown>
      }
    ): void => callback(progress)
    ipcRenderer.on('training:progress', listener)
    return () => ipcRenderer.removeListener('training:progress', listener)
  },

  openLyricsFileDialog: (): Promise<{ filePath: string; content: string } | null> =>
    ipcRenderer.invoke('dialog:openLyricsFile'),

  // Song APIs
  createSongFolder: (
    parentPath: string,
    folderName: string,
    audioPath?: string
  ): Promise<{ id: string; path: string; name: string } | null> =>
    ipcRenderer.invoke('song:createFolder', parentPath, folderName, audioPath),

  deleteSongFolder: (songPath: string): Promise<boolean> =>
    ipcRenderer.invoke('song:deleteFolder', songPath),

  importAudio: (
    songPath: string,
    audioSourcePath: string
  ): Promise<{ filePath: string; filename: string } | null> =>
    ipcRenderer.invoke('song:importAudio', songPath, audioSourcePath),

  readSongIni: (songPath: string): Promise<Record<string, string | number> | null> =>
    ipcRenderer.invoke('song:readIni', songPath),

  writeSongIni: (songPath: string, metadata: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke('song:writeIni', songPath, metadata),

  searchSongMetadata: (request: SongMetadataSearchRequest): Promise<SongMetadataSearchResult[]> =>
    ipcRenderer.invoke('song:searchMetadata', request),

  fetchMetadataArtwork: (artwork: MetadataArtwork): Promise<string | null> =>
    ipcRenderer.invoke('song:fetchMetadataArtwork', artwork),

  readSongMidi: (songPath: string): Promise<{ type: 'midi' | 'chart'; data: string } | null> =>
    ipcRenderer.invoke('song:readMidi', songPath),

  writeSongMidi: (songPath: string, midiBase64: string): Promise<boolean> =>
    ipcRenderer.invoke('song:writeMidi', songPath, midiBase64),

  writeSongChart: (songPath: string, chartText: string): Promise<boolean> =>
    ipcRenderer.invoke('song:writeChart', songPath, chartText),

  exportSng: (
    songPath: string,
    metadata: Record<string, unknown>,
    outputPath: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('song:exportSng', songPath, metadata, outputPath),

  exportCon: (
    songPath: string,
    metadata: Record<string, unknown>,
    outputPath: string
  ): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('song:exportCon', songPath, metadata, outputPath),

  fileExists: (filePath: string): Promise<boolean> => ipcRenderer.invoke('fs:fileExists', filePath),

  // Album art APIs
  readAlbumArt: (songPath: string): Promise<string | null> =>
    ipcRenderer.invoke('song:readAlbumArt', songPath),

  writeAlbumArt: (songPath: string, dataUrl: string): Promise<boolean> =>
    ipcRenderer.invoke('song:writeAlbumArt', songPath, dataUrl),

  // Audio APIs
  readAudio: (songPath: string): Promise<{ filePath: string; filename: string }[] | null> =>
    ipcRenderer.invoke('song:readAudio', songPath),

  readAudioJson: (songPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('audio:readJson', songPath),

  writeAudioJson: (songPath: string, data: unknown): Promise<boolean> =>
    ipcRenderer.invoke('audio:writeJson', songPath, data),

  readVenueJson: (songPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('venue:readJson', songPath),

  writeVenueJson: (songPath: string, data: unknown): Promise<boolean> =>
    ipcRenderer.invoke('venue:writeJson', songPath, data),

  // Video APIs
  openVideoDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openVideo'),

  importVideo: (
    songPath: string,
    videoSourcePath: string
  ): Promise<{ filePath: string; filename: string } | null> =>
    ipcRenderer.invoke('video:import', songPath, videoSourcePath),

  scanVideo: (songPath: string): Promise<{ filePath: string; filename: string } | null> =>
    ipcRenderer.invoke('video:scan', songPath),

  readVideoJson: (songPath: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('video:readJson', songPath),

  writeVideoJson: (songPath: string, data: unknown): Promise<boolean> =>
    ipcRenderer.invoke('video:writeJson', songPath, data),

  downloadVideoUrl: (
    songPath: string,
    url: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke('video:download-url', songPath, url),

  onDownloadProgress: (callback: (percent: number) => void): (() => void) => {
    const handler = (_event: unknown, percent: number): void => callback(percent)
    ipcRenderer.on('video:download-progress', handler)
    return () => ipcRenderer.removeListener('video:download-progress', handler)
  },

  getWaveformSource: (songPath: string): Promise<{ filePath: string } | null> =>
    ipcRenderer.invoke('audio:waveform', songPath),

  // Export APIs
  saveVideoDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:saveVideo'),

  exportVideo: (options: {
    videoPath: string
    audioPath: string
    outputPath: string
    offsetMs: number
    trimStartMs: number
    trimEndMs: number
  }): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('video:export', options),

  onExportProgress: (callback: (percent: number) => void): (() => void) => {
    const handler = (_event: unknown, percent: number): void => callback(percent)
    ipcRenderer.on('video:export-progress', handler)
    return () => ipcRenderer.removeListener('video:export-progress', handler)
  },

  startAutoChart: (options: {
    outputDir: string
    files: string[]
    folders: string[]
    stemFolders?: string[]
    stemSongs?: Array<{
      name?: string
      stems: Partial<
        Record<
          | 'drums'
          | 'bass'
          | 'vocals'
          | 'other'
          | 'guitar'
          | 'piano'
          | 'vocalsHarm2'
          | 'vocalsHarm3'
          | 'crowd',
          string
        >
      >
      extras?: string[]
    }>
    urls: string[]
    includeKeys?: boolean
    disableOnlineLookup?: boolean
    skipHarmonies?: boolean
    keepStems?: boolean
    starPower?: boolean
    snapDrums?: boolean
    snapDrumsDivision?: number
    snapDrumsWindowMs?: number
    autoTempo?: boolean
    autoTempoDrift?: boolean
    autoTempoSnap?: boolean
    enabledTracks?: {
      drums?: boolean
      guitar?: boolean
      bass?: boolean
      vocals?: boolean
      harmonies?: boolean
      keys?: boolean
      proKeys?: boolean
    }
  }): Promise<{ runId: string }> => ipcRenderer.invoke('strum:start', options),

  cancelAutoChart: (runId: string): Promise<boolean> => ipcRenderer.invoke('strum:cancel', runId),

  onAutoChartProgress: (
    callback: (event: {
      runId: string
      stage: string
      message: string
      percent?: number
      currentItem?: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        runId: string
        stage: string
        message: string
        percent?: number
        currentItem?: string
      }
    ): void => callback(payload)
    ipcRenderer.on('strum:progress', handler)
    return () => ipcRenderer.removeListener('strum:progress', handler)
  },

  onAutoChartComplete: (
    callback: (event: {
      runId: string
      success: boolean
      outputDir: string
      songFolders: string[]
      errors: string[]
      urlSongFolders?: Array<{ url: string; songFolder: string }>
    }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        runId: string
        success: boolean
        outputDir: string
        songFolders: string[]
        errors: string[]
        urlSongFolders?: Array<{ url: string; songFolder: string }>
      }
    ): void => callback(payload)
    ipcRenderer.on('strum:complete', handler)
    return () => ipcRenderer.removeListener('strum:complete', handler)
  },

  onAutoChartError: (
    callback: (event: { runId: string; message: string; requirementsPath?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        runId: string
        message: string
        requirementsPath?: string
      }
    ): void => callback(payload)
    ipcRenderer.on('strum:error', handler)
    return () => ipcRenderer.removeListener('strum:error', handler)
  },

  getRuntimeStatus: (): Promise<{
    managed: boolean
    ready: boolean
    installing: boolean
    pythonPath: string
    pythonBuildTag: string
    pythonVersion: string
    isUpgrade: boolean
  }> => ipcRenderer.invoke('runtime:status'),

  bootstrapRuntime: (): Promise<{ ok: boolean; skipped?: boolean; message?: string }> =>
    ipcRenderer.invoke('runtime:bootstrap'),

  // App update channel (stable vs. beta/pre-release)
  getUpdateChannel: (): Promise<{ betaChannel: boolean }> =>
    ipcRenderer.invoke('updater:getChannel'),

  setUpdateChannel: (betaEnabled: boolean): Promise<{ ok: boolean; betaChannel: boolean }> =>
    ipcRenderer.invoke('updater:setChannel', betaEnabled),

  // App updater events
  onUpdaterStatus: (
    callback: (status: {
      state:
        | 'idle'
        | 'checking'
        | 'available'
        | 'downloading'
        | 'downloaded'
        | 'not-available'
        | 'error'
      version?: string
      percent?: number
      message?: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: unknown,
      status: {
        state:
          | 'idle'
          | 'checking'
          | 'available'
          | 'downloading'
          | 'downloaded'
          | 'not-available'
          | 'error'
        version?: string
        percent?: number
        message?: string
      }
    ): void => callback(status)
    ipcRenderer.on('updater:status', handler)
    return () => ipcRenderer.removeListener('updater:status', handler)
  },

  // App menu command events
  onMenuCommand: (callback: (command: string, payload?: unknown) => void): (() => void) => {
    const handler = (_event: unknown, data: { command: string; payload?: unknown }): void => {
      callback(data.command, data.payload)
    }
    ipcRenderer.on('menu:command', handler)
    return () => ipcRenderer.removeListener('menu:command', handler)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
