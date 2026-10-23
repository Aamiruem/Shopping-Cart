"""Server-rendered SEO heads (/api/seo/page helpers) - no database needed."""

import json
import re

from app.routers.seo import _head, _ld, _render

TEMPLATE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Generic store description" />
    <!-- Link-preview defaults (WhatsApp, Facebook, X, LinkedIn); product and category pages get their own -->
    <meta property="og:type" content="website" />
    <meta property="og:title" content="Generic store title" />
    <meta name="twitter:card" content="summary_large_image" />
    <title>Arvixa — Online Shopping</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>"""


def test_render_replaces_generic_title_and_description_once():
    head = _head("Puma Trainers - Buy online at ₹7469", "Puma Trainers at ₹7469.", "/products/abc/puma-trainers", og_type="product")
    page = _render(TEMPLATE, head, "<h1>Puma Trainers</h1>")
    assert page.count("<title>") == 1 and "<title>Puma Trainers - Buy online at ₹7469 | Arvixa</title>" in page
    assert page.count('name="description"') == 1 and "Generic store description" not in page
    assert '<meta property="og:type" content="product" />' in page and page.count('property="og:type"') == 1
    assert "Generic store title" not in page and page.count('name="twitter:card"') == 1
    assert re.search(r'<link rel="canonical" href="[^"]+/products/abc/puma-trainers" />', page)
    assert '<div id="root"><h1>Puma Trainers</h1></div>' in page


def test_head_escapes_user_text():
    head = _head('<script>alert(1)</script>"x', "desc", "/products?q=x")
    assert "<script>alert" not in head and "&lt;script&gt;alert(1)&lt;/script&gt;&quot;x" in head


def test_json_ld_cannot_break_out_of_its_script_tag():
    tag = _ld({"@type": "BreadcrumbList", "name": "</script><script>alert(1)</script><!--"})
    body = tag[tag.index(">") + 1 : tag.rindex("</script>")]
    assert "<" not in body
    assert json.loads(body)["name"] == "</script><script>alert(1)</script><!--"


def test_filtered_listing_is_noindex():
    assert 'content="noindex, nofollow"' in _head("Beauty", "d", "/products?category=beauty", noindex=True)
    assert 'content="index, follow, max-image-preview:large"' in _head("Beauty", "d", "/products?category=beauty")
