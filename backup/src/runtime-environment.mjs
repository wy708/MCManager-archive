import path from 'node:path';

// process.env is case-insensitive on Windows, but its spread copy is a plain,
// case-sensitive object. Child processes must receive just one spelling per key.
export function withMapPython(environment, python, pluginDirectory) {
  const env = { ...environment };
  const find = name => Object.keys(env).find(key => key.toUpperCase() === name);
  const inheritedPath = env[find('PATH')] ?? '';
  function set(name, value) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
    env[name] = value;
  }
  set('PATH', python + (inheritedPath ? path.delimiter + inheritedPath : ''));
  set('PYTHONHOME', python);
  set('PYTHONPATH', pluginDirectory);
  set('PYTHONNOUSERSITE', '1');
  set('ENDSTONE_PYTHON_EXECUTABLE', path.join(python, 'python.exe'));
  set('PIP_NO_INDEX', '1');
  return env;
}
