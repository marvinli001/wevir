-- 0021_transcription_models：Provider 的转写模型（协议 0.89.0 的听写）。字段含义见 docs/architecture/domain-model.md §3.2。
--
-- protocol `ProviderTranscriptionModel[]` 的 JSON；之前建的 Provider 没有转写模型（NULL）。
ALTER TABLE provider_profiles ADD COLUMN transcription_models TEXT
  CHECK (transcription_models IS NULL OR json_valid(transcription_models));
