import re

with open("public/index.html", "r") as f:
    html = f.read()

# Replace the allowed_countries input
old_input = '<input type="text" class="form-control form-control-sm" name="allowed_countries" data-i18n-placeholder="allowedCountriesPlaceholder" data-i18n-label="allowedCountries" placeholder="Countries (e.g. US,GB)">'
new_select = '''<select class="form-select form-select-sm" name="allowed_countries" id="user-allowed-countries" multiple style="height: calc(1.5em + 0.5rem + 2px);">
                        <!-- Options populated dynamically -->
                     </select>'''

if old_input in html:
    html = html.replace(old_input, new_select)
else:
    print("Could not find old input. Maybe it's already modified?")

with open("public/index.html", "w") as f:
    f.write(html)
