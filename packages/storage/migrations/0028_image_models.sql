-- 0028_image_models：Provider 的图片模型（协议 0.139.0 的生图）。字段含义见 docs/architecture/domain-model.md §3.2。
--
-- protocol `ProviderImageModel[]` 的 JSON；之前建的 Provider 没有图片模型（NULL）。
ALTER TABLE provider_profiles ADD COLUMN image_models TEXT
  CHECK (image_models IS NULL OR json_valid(image_models));
