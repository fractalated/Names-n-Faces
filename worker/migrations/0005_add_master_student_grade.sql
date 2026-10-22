-- Grade level (e.g. 9-12), shown after a student's name everywhere it
-- appears ("Smith, John 9th"). Nullable: NULL just means no grade on file
-- (not yet imported, or a student missing from the grade lists). Filled by
-- admin's "Grade Levels" import (POST /api/master/grades) from the SIS
-- per-grade CSV exports, or edited per student.
ALTER TABLE master_students ADD COLUMN grade INTEGER;
