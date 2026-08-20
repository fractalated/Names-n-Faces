INSERT INTO users (id, email, password_hash, is_admin, created_at)
VALUES ('d0a961d2-fc96-49bd-a128-635d5a6fd225', 'scott.bickers@lhsparker.org', 'pbkdf2$100000$HNH2e3V65bzZ94A3+lFWuA==$xr/T6eR/wdubn3fzIs76AKsqfUyHrStwu9ItBf6/Kw0=', 1, strftime('%s','now')*1000);

INSERT INTO collections (id, user_id, slug, label, sort_order, created_at) VALUES
  ('0049ad75-e805-4f30-95e1-a8d68db19fd0', 'd0a961d2-fc96-49bd-a128-635d5a6fd225', 'period-1', 'Period 1', 1, strftime('%s','now')*1000),
  ('0092ae3d-c5ee-4064-b759-eef5c713db02', 'd0a961d2-fc96-49bd-a128-635d5a6fd225', 'period-2', 'Period 2', 2, strftime('%s','now')*1000),
  ('304c4488-f8fd-40d4-8ee5-9aea2880ab29', 'd0a961d2-fc96-49bd-a128-635d5a6fd225', 'period-3', 'Period 3', 3, strftime('%s','now')*1000),
  ('46dc948e-45f2-450d-ba3b-a47e143be672', 'd0a961d2-fc96-49bd-a128-635d5a6fd225', 'period-4', 'Period 4', 4, strftime('%s','now')*1000),
  ('dbda713f-91ed-4de0-9e3c-9f2333c4a320', 'd0a961d2-fc96-49bd-a128-635d5a6fd225', 'period-5', 'Period 5', 5, strftime('%s','now')*1000),
  ('dd075428-a6a1-4380-a8aa-891bd10822c7', 'd0a961d2-fc96-49bd-a128-635d5a6fd225', 'period-6', 'Period 6', 6, strftime('%s','now')*1000),
  ('5e1f5392-33cf-4df2-8668-b27668c569ee', 'd0a961d2-fc96-49bd-a128-635d5a6fd225', 'period-7', 'Period 7', 7, strftime('%s','now')*1000),
  ('56bef737-56ff-40ac-805a-e4e3b3180319', 'd0a961d2-fc96-49bd-a128-635d5a6fd225', 'period-8', 'Period 8', 8, strftime('%s','now')*1000),
  ('504430ec-4877-4998-a03a-c5601929ae4f', 'd0a961d2-fc96-49bd-a128-635d5a6fd225', 'period-9', 'Period 9', 9, strftime('%s','now')*1000),
  ('22e1826c-d9db-4063-9e1e-63959ed6fbc2', 'd0a961d2-fc96-49bd-a128-635d5a6fd225', 'chapel',   'Chapel',  10, strftime('%s','now')*1000);

UPDATE people SET user_id = 'd0a961d2-fc96-49bd-a128-635d5a6fd225' WHERE user_id IS NULL;
