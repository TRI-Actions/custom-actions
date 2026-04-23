#!/bin/sh -l
echo "Parsing yaml file at $FILE_PATH with format type $FORMAT_TYPE"

python /main.py \
--file_path "$FILE_PATH" \
--format_type "$FORMAT_TYPE" \
--main_key "$MAIN_KEY" \
--sub_key "$SUB_KEY" \
--primary_key "$PRIMARY_KEY" \
--primary_value "$PRIMARY_VALUE" \
--top_level_keys "$TOP_LEVEL_KEYS"
