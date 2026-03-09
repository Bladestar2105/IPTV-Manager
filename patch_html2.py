import re

with open("public/index.html", "r") as f:
    html = f.read()

# Restore the original first, then apply a better patch
html = html.replace('''<div class="col-12 col-md-4 col-lg-2">
                     <select class="form-select form-select-sm" name="allowed_countries" id="user-allowed-countries" multiple style="height: calc(1.5em + 0.5rem + 2px);">
                        <!-- Options populated dynamically -->
                     </select>
                  </div>''', '''<div class="col-12 col-lg-10">
                     <select class="form-select form-select-sm" name="allowed_countries" id="user-allowed-countries" multiple size="3">
                        <!-- Options populated dynamically -->
                     </select>
                     <div class="form-text small mt-1" style="font-size: 0.7rem;" data-i18n="allowedCountriesHelp">Select countries to allow access. Leave empty to allow all. Ctrl+Click to select multiple.</div>
                  </div>''')

# Change buttons to fit the rest 2 columns
html = html.replace('''<div class="col-9 col-md-4 col-lg-1"><button class="btn btn-sm btn-primary w-100" type="submit" data-i18n="addUser">Add</button></div>
                  <div class="col-3 col-md-2 col-lg-1"><button class="btn btn-sm btn-outline-secondary w-100" type="button" data-action="action-generate-user" data-i18n-title="generateRandomUser" data-i18n-label="generateRandomUser">⚡</button></div>''', '''<div class="col-9 col-lg-1"><button class="btn btn-sm btn-primary w-100 h-100" type="submit" data-i18n="addUser">Add</button></div>
                  <div class="col-3 col-lg-1"><button class="btn btn-sm btn-outline-secondary w-100 h-100" type="button" data-action="action-generate-user" data-i18n-title="generateRandomUser" data-i18n-label="generateRandomUser">⚡</button></div>''')


with open("public/index.html", "w") as f:
    f.write(html)
