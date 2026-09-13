-- Add missing tables for ai-khata
-- Run this after 001_initial_schema.sql

-- Add bill_attachments column to members if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='members' AND column_name='bill_attachments') THEN
        ALTER TABLE members ADD COLUMN bill_attachments JSONB;
    END IF;
END $$;

-- Add index on history timestamp
CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp);

-- Add index on otps phone
CREATE INDEX IF NOT EXISTS idx_otps_phone ON otps(phone);

-- Add index on otps verified
CREATE INDEX IF NOT EXISTS idx_otps_verified ON otps(verified);