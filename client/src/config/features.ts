// Final presentation: keep the optional activity tools off unless explicitly
// enabled for a separate evaluation build. This gates collection and UI together.
export const ACTIVITY_RECORDING_ENABLED = import.meta.env.VITE_ENABLE_ACTIVITY_RECORDING === 'true';
