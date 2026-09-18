export class SqlSyntaxError extends Error {
  constructor(message, position) {
    super(message);
    this.name = 'SqlSyntaxError';
    this.position = position;
  }
}

export class SqlSemanticError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlSemanticError';
  }
}
