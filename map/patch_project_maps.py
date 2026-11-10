from pathlib import Path
path = Path('/app/main.py')
text = path.read_text()
if 'from services.project_maps import router as project_router' not in text:
    text += '\nfrom services.project_maps import router as project_router\napp.include_router(project_router)\n'
path.write_text(text)
