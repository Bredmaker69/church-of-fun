export const SPEECH_CLEANUP_PRESET_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'strong', label: 'Strong' },
];

export const DEFAULT_SPEECH_CLEANUP_PRESET = 'medium';

export const createDefaultDialogueTrackDefaults = () => ({
  speechCleanupEnabled: false,
  speechCleanupPreset: DEFAULT_SPEECH_CLEANUP_PRESET,
});

export const createDefaultSpeechCleanupState = () => ({
  speechCleanupMode: 'inherit',
  speechCleanupPreset: DEFAULT_SPEECH_CLEANUP_PRESET,
});

export const normalizeSpeechCleanupPreset = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return SPEECH_CLEANUP_PRESET_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : DEFAULT_SPEECH_CLEANUP_PRESET;
};

export const normalizeSpeechCleanupMode = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'on' || normalized === 'off' || normalized === 'inherit') return normalized;
  return 'inherit';
};

export const normalizeDialogueTrackDefaults = (value) => {
  if (!value || typeof value !== 'object') return createDefaultDialogueTrackDefaults();
  return {
    speechCleanupEnabled: value.speechCleanupEnabled === true,
    speechCleanupPreset: normalizeSpeechCleanupPreset(value.speechCleanupPreset),
  };
};

export const normalizeSpeechCleanupState = (value) => {
  if (!value || typeof value !== 'object') return createDefaultSpeechCleanupState();
  return {
    speechCleanupMode: normalizeSpeechCleanupMode(value.speechCleanupMode),
    speechCleanupPreset: normalizeSpeechCleanupPreset(value.speechCleanupPreset),
  };
};

export const resolveEffectiveSpeechCleanup = ({ item, projectDefaults }) => {
  const defaults = normalizeDialogueTrackDefaults(projectDefaults);
  const state = normalizeSpeechCleanupState(item);
  if (state.speechCleanupMode === 'off') {
    return {
      enabled: false,
      preset: state.speechCleanupPreset,
      source: 'clip',
    };
  }
  if (state.speechCleanupMode === 'on') {
    return {
      enabled: true,
      preset: state.speechCleanupPreset,
      source: 'clip',
    };
  }
  return {
    enabled: defaults.speechCleanupEnabled,
    preset: defaults.speechCleanupPreset,
    source: 'project',
  };
};

