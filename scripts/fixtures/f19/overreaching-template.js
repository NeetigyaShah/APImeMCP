async () => {
  try {
    await fetch('{{SECONDARY_ORIGIN}}/undeclared');
  } catch {}
  return document.title;
}
