with open("public/index.html", "r") as f:
    html = f.read()

# The user-form currently has:
# col-12 col-md-4 col-lg-2 (username)
# col-12 col-md-4 col-lg-3 (password + buttons)
# col-6 col-md-4 col-lg-2 (copy from user)
# col-6 col-md-2 col-lg-1 (max connections)
# col-12 col-md-4 col-lg-2 (expiry date)
# col-12 col-md-4 col-lg-2 (allowed countries) -> this breaks row size 12
# The total lg columns: 2 + 3 + 2 + 1 + 2 + 2 = 12 columns.
# wait, wait! 2+3+2+1+2+2 = 12. So it perfectly fits on lg screens.

# If we change allowed countries to a multiple select, it will look weird as a single-line input in this row.
# Let's see how we can make it a multi-select dropdown that looks like a single line but opens as a dropdown when clicked.
# Since we don't have bootstrap-select or select2, and standard <select multiple> always takes up multiple lines.
# If we just add it to a new line by changing its container and adding a w-100 column break or putting the button on a new line, it might work better.
# But actually, the prompt says "When creating user geo block is a text field but not choice."
# So we need to change it to a choice. Can it be a multiple select with size=1 ?
# A multiple select with size=1 shows one item and a scrollbar, but you can select multiple by Ctrl+clicking.
# Alternatively, if we just use `<select class="form-select form-select-sm" name="allowed_countries" id="user-allowed-countries" multiple size="1">` it will take height as a normal input, but the user has to Ctrl+click to select multiple. Actually size=1 doesn't look bad, but it might break layout vertically.

# Let's replace the allowed_countries input with the select, but add a class to fix its height.
