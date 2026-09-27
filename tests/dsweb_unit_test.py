#!/usr/bin/env python3
import os
import sys
import unittest
import tempfile
from importlib.machinery import SourceFileLoader

repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dsweb_path = os.path.join(repo_root, "bridge", "bin", "dsweb")
dsweb = SourceFileLoader("dsweb", dsweb_path).load_module()


class TestDswebFileExpansion(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.test_file = os.path.join(self.tmpdir.name, "sample.txt")
        with open(self.test_file, "w", encoding="utf-8") as f:
            f.write("Hello world from sample file.")

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_chinese_preceding_at(self):
        prompt = f"请帮我翻译@{self.test_file}"
        res, err = dsweb.expand_prompt_files(prompt)
        self.assertIsNone(err)
        self.assertIn("Hello world from sample file.", res)
        self.assertTrue(res.startswith("请帮我翻译"))

    def test_comma_following_file(self):
        prompt = f"请你帮我翻译: @{self.test_file},它不能正常回复"
        res, err = dsweb.expand_prompt_files(prompt)
        self.assertIsNone(err)
        self.assertIn("Hello world from sample file.", res)
        self.assertTrue(res.endswith(",它不能正常回复"))

    def test_chinese_text_immediately_following(self):
        prompt = f"请帮我翻译@{self.test_file}的内容"
        res, err = dsweb.expand_prompt_files(prompt)
        self.assertIsNone(err)
        self.assertIn("Hello world from sample file.", res)
        self.assertTrue(res.endswith("的内容"))

    def test_trailing_period(self):
        prompt = f"Translate @{self.test_file}."
        res, err = dsweb.expand_prompt_files(prompt)
        self.assertIsNone(err)
        self.assertIn("Hello world from sample file.", res)
        self.assertTrue(res.endswith("."))

    def test_email_ignored(self):
        prompt = "Send email to alice@example.com for info"
        res, err = dsweb.expand_prompt_files(prompt)
        self.assertIsNone(err)
        self.assertEqual(res, prompt)

    def test_nonexistent_file(self):
        prompt = "Look at @/nonexistent/path/never_existed_123.txt please"
        res, err = dsweb.expand_prompt_files(prompt)
        self.assertIsNotNone(err)
        self.assertIn("未找到指定的文件", err)

    def test_quoted_path(self):
        space_file = os.path.join(self.tmpdir.name, "file with spaces.txt")
        with open(space_file, "w", encoding="utf-8") as f:
            f.write("spaced content")
        prompt = f'Check @"{space_file}" please'
        res, err = dsweb.expand_prompt_files(prompt)
        self.assertIsNone(err)
        self.assertIn("spaced content", res)


if __name__ == "__main__":
    unittest.main()
